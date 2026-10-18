import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { sandbox, cli, write } from './helpers.mjs';

for (const host of ['codex', 'claude']) {
    test(`${host} update fails atomically on customization; uninstall preserves user data`, t => {
        const { root } = sandbox(t);
        assert.equal(cli(root, ['install', '--host', host]).status, 0);
        const skills = host === 'codex' ? '.agents/skills' : '.claude/skills';
        const modified = `${skills}/steward-work/SKILL.md`;
        write(root, modified, 'My custom procedure');
        const configPath = host === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json';
        const config = JSON.parse(fs.readFileSync(path.join(root, configPath)));
        config.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-owned' }] });
        write(root, configPath, config);
        const before = fs.readFileSync(path.join(root, configPath), 'utf8');
        const updated = cli(root, ['update', '--host', host]);
        assert.equal(updated.status, 1);
        assert.match(updated.stderr, /INSTALL_CONFLICT/);
        assert.equal(fs.readFileSync(path.join(root, configPath), 'utf8'), before);
        write(root, '.steward/state/user-note', 'retain');
        const removed = cli(root, ['uninstall', '--host', host]);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(fs.readFileSync(path.join(root, modified), 'utf8'), 'My custom procedure');
        assert.equal(fs.existsSync(path.join(root, skills, 'steward-recall/SKILL.md')), false);
        assert.equal(fs.readFileSync(path.join(root, '.steward/state/user-note'), 'utf8'), 'retain');
        assert(fs.existsSync(path.join(root, '.steward/policy.json')));
        const remaining = JSON.parse(fs.readFileSync(path.join(root, configPath)));
        assert.deepEqual(remaining.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-owned' }] }]);
        assert.equal(cli(root, ['uninstall', '--host', host]).status, 0);
    });
}
test('update requires a receipt and refreshes a managed installation idempotently', t => {
    const { root } = sandbox(t);
    assert.equal(cli(root, ['update', '--host', 'codex']).status, 1);
    assert.equal(cli(root, ['install', '--host', 'codex']).status, 0);
    assert.equal(cli(root, ['update', '--host', 'codex']).status, 0);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.steward/install-codex.json')));
    assert.equal(receipt.packageVersion, JSON.parse(cli(root, ['version']).stdout).version);
    assert.equal(cli(root, ['doctor', '--host', 'codex']).status, 0);
});

test('antigravity host install, update, doctor, and uninstall manage .agents/hooks.json named hook schema cleanly', t => {
    const { root } = sandbox(t);
    write(root, '.agents/hooks.json', {
        'lint-checker': {
            PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh', timeout: 10 }] }]
        },
        steward: {
            enabled: true,
            PreInvocation: [{ type: 'command', command: 'echo custom-pre-invocation', timeout: 5 }],
            PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo custom-pre-tool', timeout: 5 }] }]
        }
    });

    const installed = cli(root, ['install', '--host', 'antigravity', '--plugin']);
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(fs.existsSync(path.join(root, '.agents/hooks.json')));
    assert.ok(fs.existsSync(path.join(root, '.steward/install-antigravity.json')));

    const hooksConfig = JSON.parse(fs.readFileSync(path.join(root, '.agents/hooks.json'), 'utf8'));
    assert.ok(hooksConfig['lint-checker'], 'Unrelated top-level named hooks must be preserved');
    assert.ok(hooksConfig.steward, 'Expected top-level steward named hook object');
    assert.equal(hooksConfig.steward.enabled, true);
    assert.equal(hooksConfig.hooks, undefined, 'Antigravity .agents/hooks.json must not use a top-level hooks wrapper');

    // SessionStart and PreInvocation must be flat arrays of handler objects
    assert.ok(Array.isArray(hooksConfig.steward.SessionStart));
    assert.equal(hooksConfig.steward.SessionStart.length, 1);
    assert.equal(hooksConfig.steward.SessionStart[0].type, 'command');
    assert.equal(hooksConfig.steward.SessionStart[0].timeout, 10);
    assert.match(hooksConfig.steward.SessionStart[0].command, /--event.*SessionStart/);

    assert.ok(Array.isArray(hooksConfig.steward.PreInvocation));
    assert.equal(hooksConfig.steward.PreInvocation.length, 2);
    assert.equal(hooksConfig.steward.PreInvocation[0].command, 'echo custom-pre-invocation');
    assert.match(hooksConfig.steward.PreInvocation[1].command, /--event.*PreInvocation/);

    // PreToolUse must be grouped with matcher: '*'
    assert.ok(Array.isArray(hooksConfig.steward.PreToolUse));
    assert.equal(hooksConfig.steward.PreToolUse.length, 2);
    assert.equal(hooksConfig.steward.PreToolUse[0].matcher, 'run_command');
    assert.equal(hooksConfig.steward.PreToolUse[1].matcher, '*');
    assert.equal(hooksConfig.steward.PreToolUse[1].hooks.length, 1);
    assert.match(hooksConfig.steward.PreToolUse[1].hooks[0].command, /--event.*PreToolUse/);

    const doc = cli(root, ['doctor', '--host', 'antigravity']);
    assert.equal(doc.status, 0, doc.stderr);
    const docJson = JSON.parse(doc.stdout);
    assert.equal(docJson.localHealthy, true);
    assert.equal(docJson.hosts[0].host, 'antigravity');
    assert.equal(docJson.hosts[0].status, 'configured');

    // Disabling steward hook is flagged by doctor
    hooksConfig.steward.enabled = false;
    write(root, '.agents/hooks.json', hooksConfig);
    const disabledDoc = cli(root, ['doctor', '--host', 'antigravity']);
    assert.equal(disabledDoc.status, 1);
    assert.ok(JSON.parse(disabledDoc.stdout).hosts[0].problems.some(p => /disabled/i.test(p)));

    // Restore enabled and verify update
    hooksConfig.steward.enabled = true;
    write(root, '.agents/hooks.json', hooksConfig);
    const updated = cli(root, ['update', '--host', 'antigravity', '--plugin']);
    assert.equal(updated.status, 0, updated.stderr);

    const removed = cli(root, ['uninstall', '--host', 'antigravity']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-antigravity.json')), false);
    const afterRemove = JSON.parse(fs.readFileSync(path.join(root, '.agents/hooks.json'), 'utf8'));
    assert.ok(afterRemove['lint-checker']);
    assert.deepEqual(afterRemove.steward.PreInvocation, [{ type: 'command', command: 'echo custom-pre-invocation', timeout: 5 }]);
    assert.deepEqual(afterRemove.steward.PreToolUse, [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo custom-pre-tool', timeout: 5 }] }]);
});

test('shared .agents/skills ownership across codex and antigravity preserves skills until last host is uninstalled', t => {
    const { root } = sandbox(t);
    assert.equal(cli(root, ['install', '--host', 'codex']).status, 0);
    assert.equal(cli(root, ['install', '--host', 'antigravity']).status, 0);

    const agSkillsManifest = JSON.parse(fs.readFileSync(path.join(root, '.steward/install-antigravity-skills.json'), 'utf8'));
    assert.ok(Object.keys(agSkillsManifest).length >= 8, 'Expected antigravity skill manifest to track canonical shared skills');

    const updatedAg = cli(root, ['update', '--host', 'antigravity']);
    assert.equal(updatedAg.status, 0, updatedAg.stderr);

    // Uninstalling codex while antigravity is still installed must preserve shared .agents/skills/*
    const uninstallCodex = cli(root, ['uninstall', '--host', 'codex']);
    assert.equal(uninstallCodex.status, 0, uninstallCodex.stderr);
    assert.equal(fs.existsSync(path.join(root, '.agents/skills/steward-work/SKILL.md')), true);

    const agDoctor = cli(root, ['doctor', '--host', 'antigravity']);
    assert.equal(agDoctor.status, 0, agDoctor.stderr);
    assert.equal(JSON.parse(agDoctor.stdout).localHealthy, true);

    // Uninstalling the remaining host removes shared .agents/skills/*
    const uninstallAg = cli(root, ['uninstall', '--host', 'antigravity']);
    assert.equal(uninstallAg.status, 0, uninstallAg.stderr);
    assert.equal(fs.existsSync(path.join(root, '.agents/skills/steward-work/SKILL.md')), false);
});

test('install, update, doctor, and uninstall support --host all across all three hosts', t => {
    const { root } = sandbox(t);
    const installAll = cli(root, ['install', '--host', 'all', '--plugin']);
    assert.equal(installAll.status, 0, installAll.stderr);
    const installOut = JSON.parse(installAll.stdout);
    assert.equal(installOut.hosts.length, 3);

    const doctorAll = cli(root, ['doctor', '--host', 'all']);
    assert.equal(doctorAll.status, 0, doctorAll.stderr);
    const docOut = JSON.parse(doctorAll.stdout);
    assert.equal(docOut.localHealthy, true);
    assert.equal(docOut.hosts.length, 3);

    const updateAll = cli(root, ['update', '--host', 'all', '--plugin']);
    assert.equal(updateAll.status, 0, updateAll.stderr);

    const uninstallAll = cli(root, ['uninstall', '--host', 'all']);
    assert.equal(uninstallAll.status, 0, uninstallAll.stderr);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-codex.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-claude.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.steward/install-antigravity.json')), false);
});
