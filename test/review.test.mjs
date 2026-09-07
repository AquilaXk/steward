import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, installHooks } from '../src/setup.mjs';
import { normalizeInput, encode } from '../src/adapters.mjs';
import { handleHook } from '../src/service.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { sandbox, write, rule, policy, PACKAGE } from './helpers.mjs';

for (const host of ['codex', 'claude']) {
    test(host + ' resolves relative file operations against a nested host cwd', t => {
        const { root } = sandbox(t);
        fs.mkdirSync(path.join(root, 'memory'));
        write(root, '.steward/policy.json', policy([rule({ effect: 'deny', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['memory'] } })]));
        trustBundle(root, loadBundle(root).hash);
        const raw = { hook_event_name: 'PreToolUse', cwd: path.join(root, 'memory'), tool_name: 'Write', tool_input: { file_path: 'a.md', content: 'x' } };
        assert.deepEqual(normalizeInput(host, raw, root).paths, ['memory/a.md']);
        assert.equal(handleHook(root, host, raw).result.decision, 'deny');
    });
    test(host + ' preserves customized skill files when installation is repeated', t => {
        const { root } = sandbox(t);
        installHooks(root, host);
        const prefix = host === 'claude' ? '.claude' : '.agents';
        const file = `${prefix}/skills/steward-work/SKILL.md`;
        write(root, file, 'User-owned procedure.\n');
        const result = installHooks(root, host);
        assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'User-owned procedure.\n');
        assert(result.skills.skipped.includes(file));
    });
    test(host + ' generated hook command executes from a project path containing spaces', t => {
        const { temp } = sandbox(t);
        const root = path.join(temp, 'target with spaces');
        initProject(root);
        trustBundle(root, loadBundle(root).hash);
        const installed = installHooks(root, host);
        const config = JSON.parse(fs.readFileSync(path.join(root, installed.path), 'utf8'));
        const command = config.hooks.UserPromptSubmit[0].hooks[0].command;
        const child = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 10000, cwd: root,
            input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'verify' }) });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    });
}

test('Codex patch move normalizes both paths relative to nested cwd', t => {
    const { root } = sandbox(t);
    fs.mkdirSync(path.join(root, 'src'));
    const normalized = normalizeInput('codex', { hook_event_name: 'PreToolUse', cwd: path.join(root, 'src'), tool_name: 'apply_patch', tool_input: {
        command: '*** Begin Patch\n*** Update File: a.md\n*** Move to: ../memory/a.md\n@@\n-old\n+new\n*** End Patch'
    } }, root);
    assert.deepEqual(normalized.paths, ['src/a.md', 'memory/a.md']);
});
test('nested cwd does not disguise traversal outside the project', t => {
    const { root } = sandbox(t);
    fs.mkdirSync(path.join(root, 'src'));
    const normalized = normalizeInput('claude', { hook_event_name: 'PreToolUse', cwd: path.join(root, 'src'), tool_name: 'Read', tool_input: { file_path: '../../outside.txt' } }, root);
    assert(normalized.paths[0].startsWith('@outside/'));
});
test('Claude SessionStart failure reports an error without claiming blocking support', () => {
    const result = encode('claude', 'session', { decision: 'deny', reason: 'Untrusted configuration.' });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Untrusted configuration.');
    assert.equal(result.exitCode, 2);
});
test('Codex SessionStart retains documented blocking output', () => {
    const result = encode('codex', 'session', { decision: 'deny', reason: 'Untrusted configuration.' });
    assert.equal(JSON.parse(result.stdout).continue, false);
    assert.equal(result.exitCode, 0);
});
test('new project cannot pass its completion gate with an unconfigured verification plan', async t => {
    const { root } = sandbox(t);
    const result = await runVerification(root);
    assert.equal(result.allPassed, false);
    assert.equal(result.checks[0].id, 'configure-project-checks');
    assert.equal(result.checks[0].status, 'fail');
    assert.throws(() => completionGate(root), { code: 'CHECKS_FAILED' });
});
test('Claude installation creates all eight native skills with scoped invocation controls', t => {
    const { root } = sandbox(t);
    installHooks(root, 'claude');
    const base = path.join(root, '.claude/skills');
    assert.equal(fs.readdirSync(base).length, 8);
    for (const name of fs.readdirSync(base)) {
        const body = fs.readFileSync(path.join(base, name, 'SKILL.md'), 'utf8');
        assert(body.includes(`name: ${name}\n`));
        assert.equal(body.includes('disable-model-invocation: true'), ['steward-policy', 'steward-schedule'].includes(name));
        assert.equal(fs.existsSync(path.join(base, name, 'agents/openai.yaml')), false);
    }
});
test('Codex installation copies manual-invocation metadata only for administrative skills', t => {
    const { root } = sandbox(t);
    for (const name of ['policy', 'schedule']) {
        const relative = `skills/steward-${name}/agents/openai.yaml`;
        const installed = fs.readFileSync(path.join(root, '.agents', relative), 'utf8');
        assert.equal(installed, fs.readFileSync(path.join(PACKAGE, relative.replace(/^skills\//, 'procedures/')), 'utf8'));
        assert.match(installed, /^policy:\n  allow_implicit_invocation: false\n/m);
    }
    assert.equal(fs.existsSync(path.join(root, '.agents/skills/steward-work/agents/openai.yaml')), false);
});
test('Claude import is idempotent and preserves user instructions', t => {
    const { root } = sandbox(t);
    write(root, 'CLAUDE.md', '# User instructions\nKeep this content.\n');
    installHooks(root, 'claude');
    installHooks(root, 'claude');
    const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert(text.startsWith('# User instructions\nKeep this content.\n'));
    assert.equal(text.split('\n').filter(line => line === '@AGENTS.md').length, 1);
});
test('Claude installation reuses an existing exact AGENTS import', t => {
    const { root } = sandbox(t);
    const original = '@AGENTS.md\n\nKeep user notes.\n';
    write(root, 'CLAUDE.md', original);
    installHooks(root, 'claude');
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), original);
});
test('Claude installation upgrades its old exact pointer without replacing user notes', t => {
    const { root } = sandbox(t);
    write(root, 'CLAUDE.md', '# User\n<!-- steward:claude -->\nRead AGENTS.md for the project working agreement and .agents/skills/steward-* for relevant procedures.\nTail notes.\n');
    installHooks(root, 'claude');
    const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert(text.includes('@AGENTS.md'));
    assert(text.startsWith('# User\n'));
    assert(text.endsWith('Tail notes.\n'));
});
test('local usage records real executable, toolkit, project and example locations', t => {
    const { root } = sandbox(t);
    const body = fs.readFileSync(path.join(root, '.steward/USAGE.md'), 'utf8');
    for (const value of [process.execPath, path.join(PACKAGE, 'bin/steward.mjs'), root, path.join(PACKAGE, 'examples')])
        assert(body.includes(JSON.stringify(value)));
    assert(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.steward/USAGE.md'));
});
