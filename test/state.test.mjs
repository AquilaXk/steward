import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendEntry, readJournal, journalHead } from '../src/journal.mjs';
import { requireTrust, loadBundle, trustBundle } from '../src/trust.mjs';
import { atomicWrite, safePath, withLock } from '../src/fs.mjs';
import { PACKAGE, sandbox, write, checkpoint } from './helpers.mjs';
const decision = (statement = 'Use one provider-neutral engine.', supersedes = null) => ({ type: 'decision', data: { statement, supersedes, authority: { kind: 'user', reference: 'test conversation', quote: 'Use this design.' } } });
test('untrusted project cannot activate its rules', t => { const { root } = sandbox(t, { trusted: false }); assert.throws(() => requireTrust(root), { code: 'UNTRUSTED' }); });
test('policy edits invalidate trust', t => { const { root } = sandbox(t); const b = loadBundle(root); b.policy.rules[0].body = 'Different'; write(root, '.steward/policy.json', b.policy); assert.throws(() => requireTrust(root), { code: 'TRUST_CHANGED' }); });
test('command edits invalidate trust', t => { const { root } = sandbox(t); const b = loadBundle(root); b.plan.checks[0].argv = ['node', '-e', '1']; write(root, '.steward/verify.json', b.plan); assert.throws(() => requireTrust(root), { code: 'TRUST_CHANGED' }); });
test('approval must match exact reviewed bundle', t => { const { root } = sandbox(t, { trusted: false }); assert.throws(() => trustBundle(root, 'a'.repeat(64)), { code: 'APPROVAL_MISMATCH' }); });
test('trust record cannot live inside project', t => { const { root } = sandbox(t, { trusted: false }); process.env.STEWARD_TRUST_HOME = path.join(root, 'trust'); assert.throws(() => trustBundle(root, loadBundle(root).hash), { code: 'TRUST_LOCATION' }); });
test('broken JSON is not replaced with an empty policy', t => { const { root } = sandbox(t); write(root, '.steward/policy.json', '{broken'); assert.throws(() => requireTrust(root), { code: 'INVALID_JSON' }); });
test('missing catalog is an error, not an implicit empty policy', t => { const { root } = sandbox(t); fs.unlinkSync(path.join(root, '.steward/policy.json')); assert.throws(() => requireTrust(root), { code: 'ENOENT' }); });
test('journal entries have a verifiable chain', async (t) => { const { root } = sandbox(t); const a = await appendEntry(root, decision()), b = await appendEntry(root, checkpoint); const rows = readJournal(root); assert.equal(rows.length, 2); assert.equal(b.previous, a.hash); assert.deepEqual(journalHead(rows), { count: 2, head: b.hash }); });
test('concurrent writers serialize without lost entries', async (t) => { const { root } = sandbox(t); await Promise.all(Array.from({ length: 16 }, () => appendEntry(root, checkpoint))); assert.equal(readJournal(root).length, 16); });
test('supersede appends without touching old entry', async (t) => { const { root } = sandbox(t); const a = await appendEntry(root, decision()); const old = JSON.stringify(readJournal(root)[0]); await appendEntry(root, decision('A revised decision.', a.hash)); assert.equal(JSON.stringify(readJournal(root)[0]), old); });
test('unknown supersede target is rejected', async (t) => { const { root } = sandbox(t); await assert.rejects(() => appendEntry(root, decision('New', 'a'.repeat(64))), { code: 'BAD_SUPERSEDE' }); });
test('an already superseded decision cannot fork quietly', async (t) => { const { root } = sandbox(t); const a = await appendEntry(root, decision()); await appendEntry(root, decision('B', a.hash)); await assert.rejects(() => appendEntry(root, decision('C', a.hash)), { code: 'BAD_SUPERSEDE' }); });
test('edited record is detected before append', async (t) => { const { root } = sandbox(t); await appendEntry(root, checkpoint); const dir = path.join(root, '.steward/state/journal'), file = path.join(dir, fs.readdirSync(dir)[0]); const row = JSON.parse(fs.readFileSync(file)); row.data.summary = 'tampered'; fs.writeFileSync(file, JSON.stringify(row)); assert.throws(() => readJournal(root), { code: 'JOURNAL_CORRUPT' }); await assert.rejects(() => appendEntry(root, checkpoint), { code: 'JOURNAL_CORRUPT' }); });
test('retained external anchor detects deleted suffix', async (t) => { const { root } = sandbox(t); await appendEntry(root, checkpoint); await appendEntry(root, checkpoint); const anchor = journalHead(readJournal(root)); const dir = path.join(root, '.steward/state/journal'); fs.unlinkSync(path.join(dir, fs.readdirSync(dir).sort().at(-1))); assert.throws(() => readJournal(root, { anchor }), { code: 'ANCHOR_MISMATCH' }); });
test('verification provenance is reserved from generic journal writes', async (t) => { const { root } = sandbox(t); await assert.rejects(() => appendEntry(root, { type: 'verification', data: { allPassed: true } }), { code: 'SCHEMA' }); });
test('a complete goal cannot cite invented evidence', async (t) => { const { root } = sandbox(t); await assert.rejects(() => appendEntry(root, { type: 'goal', data: { objective: 'Ship', acceptance: ['Checked'], status: 'complete', evidence: ['invented'] } }), { code: 'NO_EVIDENCE' }); });
test('exclusive creation cannot overwrite existing evidence', t => { const { root } = sandbox(t); atomicWrite(root, 'evidence.txt', 'first'); assert.throws(() => atomicWrite(root, 'evidence.txt', 'second'), { code: 'EEXIST' }); assert.equal(fs.readFileSync(path.join(root, 'evidence.txt'), 'utf8'), 'first'); });
test('control-plane traversal is rejected', t => { const { root } = sandbox(t); assert.throws(() => safePath(root, '../outside'), { code: 'PATH_ESCAPE' }); });
test('symlink control path is rejected', t => {
    const { root, temp } = sandbox(t);
    const link = path.join(root, 'linked');
    try {
        fs.symlinkSync(temp, link, 'junction');
    }
    catch (e) {
        if (e.code === 'EPERM') {
            t.skip('Symlink permission unavailable.');
            return;
        }
        throw e;
    }
    assert.throws(() => safePath(root, 'linked/x'), { code: 'SYMLINK' });
});
test('abandoned lock is reported, never silently removed', async (t) => { const { root } = sandbox(t); write(root, 'lock-parent/keep', 'x'); fs.mkdirSync(path.join(root, 'lock-parent/lock')); await assert.rejects(() => withLock(root, 'lock-parent/lock', () => { }, 30), { code: 'LOCKED' }); assert.ok(fs.existsSync(path.join(root, 'lock-parent/lock'))); });
test('trust reads also reject a project-local trust home', t => { const { root } = sandbox(t); process.env.STEWARD_TRUST_HOME = path.join(root, 'trust'); assert.throws(() => requireTrust(root), { code: 'TRUST_LOCATION' }); });
test('independent CLI processes append to one journal without lost records', async (t) => {
    const { root } = sandbox(t);
    write(root, 'checkpoint-entry.json', checkpoint);
    const workers = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(PACKAGE, 'bin/steward.mjs'), 'journal', 'add', '--file', path.join(root, 'checkpoint-entry.json'), '--project', root], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdout.resume();
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`Journal child exited ${code}: ${stderr}`)));
    }));
    await Promise.all(workers);
    assert.equal(readJournal(root).length, 8);
});
