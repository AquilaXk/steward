import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { sandbox, plan, checkpoint, write, cli } from './helpers.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { appendEntry, readJournal, saveCompaction } from '../src/journal.mjs';
import { sha256, canonical } from '../src/fs.mjs';
import { handleHook } from '../src/service.mjs';
import { installHooks } from '../src/setup.mjs';
import { loadBundle, trustBundle, requireTrust } from '../src/trust.mjs';
import { normalizeInput } from '../src/adapters.mjs';

test('project aliases use one trust identity and host cwd boundary', t => {
    const { root, temp } = sandbox(t);
    const alias = path.join(temp, 'project-alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    trustBundle(alias, loadBundle(root).hash);
    assert.equal(requireTrust(alias).hash, requireTrust(root).hash);
    assert.equal(fs.readdirSync(path.join(process.env.STEWARD_TRUST_HOME, 'trust')).length, 1);
    process.env.STEWARD_TRUST_HOME = path.join(alias, 'inside-trust');
    assert.throws(() => trustBundle(alias, loadBundle(root).hash), { code: 'TRUST_LOCATION' });
    const event = normalizeInput('claude', { hook_event_name: 'PreToolUse', cwd: alias,
        tool_name: 'Write', tool_input: { file_path: 'memory/note.md' } }, root);
    assert.deepEqual(event.paths, ['memory/note.md']);
});

function rewriteLast(root, mutate) {
    const directory = path.join(root, '.steward/state/journal');
    const file = path.join(directory, fs.readdirSync(directory).sort().at(-1));
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(row);
    const { hash, ...payload } = row;
    fs.writeFileSync(file, JSON.stringify({ ...payload, hash: sha256(canonical(payload)) }));
}

test('removing executable permission invalidates previously passing evidence', { skip: process.platform === 'win32' }, async t => {
    const { root } = sandbox(t, { plan: plan('', { argv: ['./check.sh'] }) });
    write(root, 'check.sh', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(root, 'check.sh'), 0o755);
    await runVerification(root);
    assert.equal(completionGate(root).pass, true);
    fs.chmodSync(path.join(root, 'check.sh'), 0o644);
    assert.throws(() => completionGate(root), { code: 'STALE_SOURCE' });
});

for (const [label, mutate] of [
    ['unsupported envelope version', row => { row.version = 99; }],
    ['oversized checkpoint', row => { row.data.summary = 'x'.repeat(5000); }],
    ['unknown record type', row => { row.type = 'unknown'; }],
    ['filename identity mismatch', row => { row.id = '00000000-0000-4000-8000-000000000000'; }]
]) {
    test('journal rejects hash-valid ' + label, async t => {
        const { root } = sandbox(t);
        await appendEntry(root, checkpoint);
        rewriteLast(root, mutate);
        assert.throws(() => readJournal(root), { code: 'JOURNAL_CORRUPT' });
    });
}

test('journal rejects malformed internal verification data before gate consumption', async t => {
    const { root } = sandbox(t, { plan: plan() });
    await runVerification(root);
    rewriteLast(root, row => { row.data.runtime = null; });
    assert.throws(() => readJournal(root), { code: 'JOURNAL_CORRUPT' });
});

test('session restore and compaction select only the matching checkpoint', async t => {
    const { root } = sandbox(t);
    for (const session of ['A', 'B'])
        await appendEntry(root, { type: 'checkpoint', data: { ...checkpoint.data, summary: 'Work ' + session, session: sha256(session) } });
    const restored = handleHook(root, 'generic', { event: 'session', text: '', tool: null, paths: [], sessionId: 'A' });
    assert.match(restored.result.context, /Work A/);
    assert.doesNotMatch(restored.result.context, /Work B/);
    const compacted = saveCompaction(root, 'A');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, compacted.path))).checkpoint.data.summary, 'Work A');
    assert.equal(saveCompaction(root, 'missing').hasCheckpoint, false);
    assert.equal(saveCompaction(root, null).hasCheckpoint, false);
});

test('named session never falls back to an unscoped checkpoint', async t => {
    const { root } = sandbox(t);
    await appendEntry(root, checkpoint);
    assert.equal(saveCompaction(root, 'new-session').hasCheckpoint, false);
    assert.equal(saveCompaction(root, null).hasCheckpoint, true);
});

test('checkpoint CLI stores a session digest and restores through a host event', t => {
    const { root } = sandbox(t);
    write(root, 'checkpoint.json', checkpoint.data);
    const saved = cli(root, ['checkpoint', '--file', path.join(root, 'checkpoint.json'), '--session-id', 'private-session']);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).data.session, sha256('private-session'));
    assert.ok(!saved.stdout.includes('private-session'));
    assert.equal(saveCompaction(root, 'private-session').hasCheckpoint, true);
});

test('installation preflight leaves hooks untouched when a skill destination is a symlink', t => {
    const { root, temp } = sandbox(t);
    const config = { custom: 'preserve' };
    write(root, '.claude/settings.local.json', config);
    fs.symlinkSync(temp, path.join(root, '.claude/skills'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => installHooks(root, 'claude'), { code: 'SYMLINK' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.local.json'))), config);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-claude.json')), false);
});

test('installation rolls back earlier writes if a later file write fails', t => {
    const { root } = sandbox(t);
    const original = '{"custom":"keep bytes"}\n';
    write(root, '.claude/settings.local.json', original);
    const originalLink = fs.linkSync;
    t.mock.method(fs, 'linkSync', (source, target) => {
        if (target.includes(path.join('.claude', 'skills'))) {
            const error = new Error('Injected write failure'); error.code = 'EIO'; throw error;
        }
        return originalLink(source, target);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.throws(() => installHooks(root, 'claude'), { code: 'INSTALL_FAILED' });
    assert.equal(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-claude.json')), false);
});
