#!/usr/bin/env node
// A real, isolated end-to-end run. No model, network or persistent user config.
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initProject } from '../src/setup.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { appendEntry, readJournal } from '../src/journal.mjs';
import { handleHook } from '../src/service.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { report } from '../src/audit.mjs';
import { sha256 } from '../src/fs.mjs';
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-demo-')));
const root = path.join(temp, 'project with spaces');
const oldTrustHome = process.env.STEWARD_TRUST_HOME;
process.env.STEWARD_TRUST_HOME = path.join(temp, 'trust');
const write = (relative, value) => {
    const dest = path.join(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};
try {
    initProject(root);
    write('cost.mjs', `export function cost(units) {\n  if (!Number.isInteger(units) || units < 1) throw new RangeError('units must be a positive integer');\n  return 100 + Math.max(0, units - 5) * 20;\n}\n`);
    write('cost.test.mjs', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { cost } from './cost.mjs';\ntest('base cost', () => assert.equal(cost(5), 100));\ntest('additional unit cost', () => assert.equal(cost(7), 140));\ntest('invalid input stays invalid', () => assert.throws(() => cost(0), RangeError));\n`);
    write('.steward/verify.json', {
        version: 1, maxAgeSeconds: 3600,
        checks: [{ id: 'cost-contract', description: 'Verify an illustrative cost function, a synthetic arithmetic fixture.', argv: ['node', '--test', 'cost.test.mjs'], timeoutMs: 10000 }]
    });
    const policy = loadBundle(root).policy;
    policy.rules.push({ id: 'protect-policy', on: ['tool'], effect: 'deny', priority: 1000, body: 'Review policy changes outside this agent action.', required: false, match: { tools: ['Edit', 'Write'], pathPrefixes: ['.steward/policy.json'] } });
    write('.steward/policy.json', policy);
    // This script owns the temporary workspace and explicitly approves only its own fixture.
    trustBundle(root, loadBundle(root).hash);
    await appendEntry(root, { type: 'checkpoint', data: { summary: 'Synthetic cost function implemented.', next: 'Run the approved cost contract checks.', blockers: [], session: sha256('demo') } });
    const prompt = handleHook(root, 'generic', { event: 'prompt', text: 'Verify the cost change and finish.', tool: null, paths: [], sessionId: 'demo' });
    assert.equal(prompt.result.decision, 'allow');
    const denied = handleHook(root, 'codex', { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .steward/policy.json\n@@\n-old\n+new\n*** End Patch' }, session_id: 'demo' });
    assert.equal(JSON.parse(denied.encoded.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const compacted = handleHook(root, 'claude', { hook_event_name: 'PreCompact', cwd: root, session_id: 'demo', trigger: 'auto' });
    assert(fs.existsSync(path.join(root, compacted.result.snapshot.path)));
    assert.equal(compacted.encoded.stdout, '{}');
    const verification = await runVerification(root);
    assert.equal(verification.allPassed, true);
    const gate = completionGate(root, verification.evidence);
    await appendEntry(root, { type: 'goal', data: { objective: 'Implement and check an illustrative cost function.', acceptance: ['The three local contract tests pass.'], status: 'complete', evidence: [gate.evidence] } });
    const resumed = handleHook(root, 'codex', { hook_event_name: 'SessionStart', cwd: root, source: 'compact', session_id: 'demo' });
    assert(resumed.result.context.includes('Synthetic cost function'));
    const beforeChange = { pass: gate.pass, checks: verification.checks.map(({ id, status }) => ({ id, status })), journalRecords: readJournal(root).length };
    write('cost.mjs', fs.readFileSync(path.join(root, 'cost.mjs'), 'utf8') + '\n// Source changed after verification.\n');
    let staleRejected = false;
    try {
        completionGate(root, verification.evidence);
    }
    catch (error) {
        staleRejected = error.code === 'STALE_SOURCE';
    }
    assert(staleRejected, 'Old evidence must not approve changed source.');
    console.log(JSON.stringify({ pass: true, isolated: true, syntheticFixture: true, promptRulesPrepared: prompt.result.emitted, codexAliasDenied: true, compactionFileWritten: true, checkpointRestored: true, verification: beforeChange, changedSourceRejected: staleRejected, audit: report(root), liveHostInvoked: false, modelApiCalls: 0 }, null, 2));
}
catch (error) {
    console.error(JSON.stringify({ pass: false, code: error.code || 'DEMO_FAILED', message: error.message }, null, 2));
    process.exitCode = 1;
}
finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (oldTrustHome === undefined)
        delete process.env.STEWARD_TRUST_HOME;
    else
        process.env.STEWARD_TRUST_HOME = oldTrustHome;
}
