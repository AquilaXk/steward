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
