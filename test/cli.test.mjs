import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, installHooks } from '../src/setup.mjs';
import { auditInstructions } from '../src/instructions.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { PACKAGE, sandbox, cli, write, event, rule, policy, plan } from './helpers.mjs';
test('init is idempotent and preserves user AGENTS content', t => { const { root } = sandbox(t); const p = path.join(root, 'AGENTS.md'); fs.appendFileSync(p, '\nUser-owned notes.\n'); const before = fs.readFileSync(p, 'utf8'); const out = initProject(root); assert.equal(fs.readFileSync(p, 'utf8'), before); assert.ok(out.skipped.includes('AGENTS.md')); });
test('init installs all eight actual skills', t => { const { root } = sandbox(t); assert.equal(fs.readdirSync(path.join(root, '.agents/skills')).length, 8); });
for (const host of ['codex', 'claude']) {
    test(host + ' install preserves unrelated handlers and is idempotent', t => { const { root } = sandbox(t); const rel = host === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json'; write(root, rel, { custom: 'keep', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo preserve' }] }] } }); installHooks(root, host); installHooks(root, host); const c = JSON.parse(fs.readFileSync(path.join(root, rel))); assert.equal(c.custom, 'keep'); assert.equal(c.hooks.PreToolUse.length, 2); assert.equal(c.hooks.PreToolUse[0].hooks[0].command, 'echo preserve'); });
}
test('CLI evaluates a draft without trust and says simulation', t => { const { root } = sandbox(t, { trusted: false }); write(root, 'event.json', event('verify')); const r = cli(root, ['eval', '--input', path.join(root, 'event.json')]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).simulation, true); });
test('CLI invalid tool input returns a host-level denial', t => { const { root } = sandbox(t); const r = cli(root, ['hook', '--host', 'codex', '--event', 'PreToolUse'], '{broken'); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny'); });
test('CLI missing project policy never permits generic execution', t => { const { root } = sandbox(t); fs.unlinkSync(path.join(root, '.steward/policy.json')); const r = cli(root, ['hook', '--host', 'generic'], event()); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).decision, 'deny'); });
test('CLI doctor fails on an untrusted project', t => { const { root } = sandbox(t, { trusted: false }); const r = cli(root, ['doctor']); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stderr).error.code, 'UNTRUSTED'); });
test('CLI verifier and completion gate work end to end', t => { const { root } = sandbox(t, { plan: plan() }); const a = cli(root, ['verify']); assert.equal(a.status, 0, a.stderr); const b = cli(root, ['gate']); assert.equal(b.status, 0, b.stderr); assert.equal(JSON.parse(b.stdout).pass, true); });
test('instruction inventory flags approval stalls with source locations', t => { const { root } = sandbox(t); write(root, 'AGENTS.md', 'Always ask for approval before every action.\n'); const r = auditInstructions(root); assert.equal(r.completeSecurityReview, false); assert.ok(r.files.find(f => f.path === 'AGENTS.md').findings.some(f => f.code === 'approval-stall' && f.line === 1)); });
test('actual prepared report excludes budget-dropped rules', t => { const { root } = sandbox(t); write(root, '.steward/policy.json', policy([rule({ id: 'a', body: 'a'.repeat(4000) }), rule({ id: 'b', body: 'b'.repeat(4000) })])); trustBundle(root, loadBundle(root).hash); const h = cli(root, ['hook', '--host', 'generic'], event()); assert.equal(h.status, 0, h.stderr); const r = cli(root, ['report']); assert.deepEqual(JSON.parse(r.stdout).emitted, { a: 1 }); });
test('hook CLI option errors also produce a host denial', t => { const { root } = sandbox(t); const r = cli(root, ['hook', '--host', 'codex', '--event', 'PreToolUse', '--unknown-option'], event()); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny'); });
test('init fills an existing empty AGENTS file without clobbering other files', t => {
    const { root } = sandbox(t);
    write(root, 'AGENTS.md', '');
    initProject(root);
    assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Steward working agreement/);
});
test('malformed UTF-8 on stdin cannot be silently repaired into an accepted request', t => {
    const { root } = sandbox(t);
    const raw = Buffer.concat([Buffer.from('{"event":"prompt","text":"'), Buffer.from([0xff]), Buffer.from('","tool":null,"paths":[],"sessionId":null}')]);
    const child = spawnSync(process.execPath, [path.join(PACKAGE, 'bin/steward.mjs'), 'hook', '--host', 'generic', '--project', root], { input: raw, encoding: 'utf8', env: process.env, timeout: 10000 });
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).decision, 'deny');
});
