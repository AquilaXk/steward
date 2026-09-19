import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerification, completionGate, resolveCommand } from '../src/verify.mjs';
import { appendEntry } from '../src/journal.mjs';
import { sandbox, plan, write } from './helpers.mjs';
test('successful checks produce current evidence and allow the local gate', async (t) => { const { root } = sandbox(t, { plan: plan() }); const r = await runVerification(root); assert.equal(r.allPassed, true); assert.equal(completionGate(root).evidence, r.evidence); });
test('failed check cannot be called complete', async (t) => { const { root } = sandbox(t, { plan: plan('process.exit(3)') }); const r = await runVerification(root); assert.equal(r.checks[0].status, 'fail'); assert.equal(r.allPassed, false); assert.throws(() => completionGate(root), { code: 'CHECKS_FAILED' }); });
test('missing executable is unavailable rather than passed', async (t) => { const { root } = sandbox(t, { plan: plan('', { argv: ['missing-steward-fixture-binary'] }) }); const r = await runVerification(root); assert.equal(r.checks[0].status, 'unavailable'); assert.equal(r.allPassed, false); });
test('timed-out child is failed and cannot unlock gate', async (t) => { const { root } = sandbox(t, { plan: plan('setTimeout(()=>{},10000)', { timeoutMs: 60 }) }); const r = await runVerification(root); assert.equal(r.checks[0].error, 'ETIMEDOUT'); assert.equal(r.allPassed, false); });
test('source mutation after a passing run invalidates evidence', async (t) => { const { root } = sandbox(t, { plan: plan() }); await runVerification(root); write(root, 'new-source.txt', 'changed'); assert.throws(() => completionGate(root), { code: 'STALE_SOURCE' }); });
test('source mutation during a run invalidates an otherwise zero exit', async (t) => { const { root } = sandbox(t, { plan: plan("require('fs').writeFileSync('source.txt','changed')") }); const r = await runVerification(root); assert.equal(r.checks[0].status, 'pass'); assert.equal(r.sourceUnchanged, false); assert.equal(r.allPassed, false); });
test('arbitrary argv text is not run through a shell', async (t) => { const { root } = sandbox(t, { plan: plan('', { argv: ['node', '-e', "console.log(process.argv[1])", '; touch SHOULD_NOT_EXIST'] }) }); const r = await runVerification(root); assert.equal(r.allPassed, true); assert.equal(fs.existsSync(path.join(root, 'SHOULD_NOT_EXIST')), false); });
test('provider credentials are not inherited by verification commands', async (t) => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
    t.after(() => {
        if (old === undefined)
            delete process.env.OPENAI_API_KEY;
        else
            process.env.OPENAI_API_KEY = old;
    });
    const { root } = sandbox(t, { plan: plan("process.exit(process.env.OPENAI_API_KEY ? 1 : 0)") });
    assert.equal((await runVerification(root)).allPassed, true);
});
test('no stored evidence means no completion assertion', t => { const { root } = sandbox(t); assert.throws(() => completionGate(root), { code: 'NO_EVIDENCE' }); });
test('excessive child output is failed, not silently accepted', async (t) => { const { root } = sandbox(t, { plan: plan("process.stdout.write('x'.repeat(2*1024*1024))") }); const r = await runVerification(root); assert.equal(r.allPassed, false); assert.equal(r.checks[0].status, 'fail'); });
test('complete goal can reference the unchanged passing snapshot', async (t) => { const { root } = sandbox(t, { plan: plan() }); const r = await runVerification(root); await appendEntry(root, { type: 'goal', data: { objective: 'Fixture complete', acceptance: ['Focused fixture check passed'], status: 'complete', evidence: [r.evidence] } }); assert.equal(completionGate(root).pass, true); });
test('edited verification stdout invalidates the evidence', async (t) => { const { root } = sandbox(t, { plan: plan('console.log("observed")') }); const r = await runVerification(root); write(root, r.checks[0].stdout.path, 'forged output'); assert.throws(() => completionGate(root), { code: 'OUTPUT_CHANGED' }); });
test('deleted verification output invalidates the evidence', async (t) => { const { root } = sandbox(t, { plan: plan() }); const r = await runVerification(root); fs.unlinkSync(path.join(root, r.checks[0].stderr.path)); assert.throws(() => completionGate(root), { code: 'OUTPUT_CHANGED' }); });
test('resolveCommand resolves node and preserves custom binaries', () => {
    assert.equal(resolveCommand('node', {}), process.execPath);
    assert.equal(resolveCommand('custom-binary-xyz', {}), 'custom-binary-xyz');
});
test('resolveCommand simulates Windows .cmd resolution', t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-win-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    fs.writeFileSync(path.join(temp, 'tool.cmd'), '@echo off\n');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
    const resolved = resolveCommand('tool', { PATH: temp, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    assert.equal(resolved.toLowerCase(), path.join(temp, 'tool.cmd').toLowerCase());
});
test('verification plan exclude allows build artifacts without invalidating source', async t => {
    const { root } = sandbox(t, {
        plan: {
            version: 1,
            maxAgeSeconds: 3600,
            exclude: ['dist'],
            checks: [{
                id: 'build-check',
                description: 'Build outputs to dist',
                argv: ['node', '-e', "require('fs').mkdirSync('dist', {recursive:true}); require('fs').writeFileSync('dist/bundle.js', 'out');"],
                timeoutMs: 2000
            }]
        }
    });
    const r = await runVerification(root);
    assert.equal(r.checks[0].status, 'pass');
    assert.equal(r.sourceUnchanged, true);
    assert.equal(r.allPassed, true);
    assert.equal(completionGate(root).pass, true);
});
