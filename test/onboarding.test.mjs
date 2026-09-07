import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { installHooks } from '../src/setup.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { handleHook } from '../src/service.mjs';
import { report } from '../src/audit.mjs';
import { PACKAGE, sandbox, cli, write, policy, rule, event } from './helpers.mjs';

test('doctor does not report an uninstalled host as healthy', t => {
    const { root } = sandbox(t);
    const result = cli(root, ['doctor', '--host', 'codex']);
    const out = JSON.parse(result.stdout);
    assert.equal(out.healthy, false);
    assert.equal(out.hosts[0].status, 'not-installed');
    assert.equal(out.liveHostVerified, false);
});

for (const host of ['codex', 'claude']) {
    test(`${host} doctor distinguishes local wiring from native observation`, t => {
        const { root } = sandbox(t);
        installHooks(root, host);
        const result = cli(root, ['doctor', '--host', host]);
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout);
        assert.equal(out.localHealthy, true);
        assert.equal(out.healthy, false);
        assert.equal(out.hosts[0].status, 'configured');
        assert.equal(out.hosts[0].nativeStatus, 'unchecked');
    });

    test(`${host} doctor detects removed hooks and preserves unrelated configuration`, t => {
        const { root } = sandbox(t);
        const installed = installHooks(root, host);
        const config = JSON.parse(fs.readFileSync(path.join(root, installed.path)));
        config.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unrelated' }] });
        write(root, installed.path, config);
        assert.equal(JSON.parse(cli(root, ['doctor', '--host', host]).stdout).localHealthy, true);
        config.hooks.SessionStart = [];
        write(root, installed.path, config);
        const result = cli(root, ['doctor', '--host', host]);
        assert.equal(result.status, 1);
        const out = JSON.parse(result.stdout);
        assert.equal(out.localHealthy, false);
        assert.equal(out.hosts[0].status, 'broken');
        assert(out.hosts[0].problems.some(p => p.includes('SessionStart')));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, installed.path))), config);
    });
}

test('doctor detects a narrowed matcher and malformed hook configuration', t => {
    const { root } = sandbox(t);
    const installed = installHooks(root, 'codex');
    const config = JSON.parse(fs.readFileSync(path.join(root, installed.path)));
    config.hooks.PreToolUse[0].matcher = 'Bash';
    write(root, installed.path, config);
    assert.equal(cli(root, ['doctor', '--host', 'codex']).status, 1);
    write(root, installed.path, '{broken');
    const result = cli(root, ['doctor', '--host', 'codex']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).hosts[0].status, 'broken');
});

test('plugin setup configures the runner without duplicate project skills', t => {
    const { temp } = sandbox(t);
    const root = path.join(temp, 'plugin-project');
    const initialized = cli(root, ['init', '--plugin']);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(fs.existsSync(path.join(root, '.agents/skills')), false);
    trustBundle(root, loadBundle(root).hash);
    for (const host of ['codex', 'claude']) {
        const installed = cli(root, ['install', '--host', host, '--plugin']);
        assert.equal(installed.status, 0, installed.stderr);
        const result = JSON.parse(installed.stdout);
        assert.equal(result.skills.source, 'plugin');
        assert.equal(fs.existsSync(path.join(root, '.claude/skills')), false);
        assert.equal(fs.existsSync(path.join(root, '.agents/skills')), false);
        assert.equal(JSON.parse(cli(root, ['doctor', '--host', host]).stdout).localHealthy, true);
    }
    assert(fs.readFileSync(path.join(root, '.steward/USAGE.md'), 'utf8').includes('bin/steward.mjs'));
});

test('report identifies unused and budget-omitted rules within the current bundle', t => {
    const { root } = sandbox(t);
    write(root, '.steward/policy.json', policy([
        rule({ id: 'used', body: 'a'.repeat(4000), priority: 200 }),
        rule({ id: 'budget', body: 'b'.repeat(4000) }),
        rule({ id: 'silent', match: { wordsAny: ['absent'] } })
    ]));
    trustBundle(root, loadBundle(root).hash);
    handleHook(root, 'generic', event('hello'));
    const out = report(root);
    assert.deepEqual(out.current.neverEmitted, ['budget', 'silent']);
    assert.equal(out.current.rules.find(r => r.id === 'budget').omitted, 1);
    assert.equal(out.current.rules.find(r => r.id === 'silent').matched, 0);
    assert(out.current.rules.find(r => r.id === 'used').lastPreparedAt);
    assert.equal(out.hostAcknowledged, false);
    assert.equal(out.retention.remaining, out.retention.limit - 1);
    write(root, '.steward/policy.json', policy([rule({ id: 'used', body: 'Changed meaning.' })]));
    const changed = report(root);
    assert.equal(changed.current.receipts, 0);
    assert.deepEqual(changed.current.neverEmitted, ['used']);
    assert.equal(changed.emitted.used, 1);
});

test('report capacity includes recovery files counted by the audit writer', t => {
    const { root } = sandbox(t);
    write(root, '.steward/state/audit/.tmp-recovery', 'incomplete');
    const out = report(root);
    assert.equal(out.receipts, 0);
    assert.equal(out.retention.remaining, out.retention.limit - 1);
});

test('both marketplaces resolve the packaged toolkit and share its version', () => {
    const read = p => JSON.parse(fs.readFileSync(path.join(PACKAGE, p)));
    const pkg = read('package.json');
    for (const host of ['codex', 'claude']) {
        const manifest = read(`.${host}-plugin/plugin.json`);
        assert.equal(manifest.name, pkg.name);
        assert.equal(manifest.version, pkg.version);
        assert.equal(manifest.skills, host === 'codex' ? './procedures/' : './.claude-plugin/skills/');
    }
    const codex = read('.agents/plugins/marketplace.json');
    const claude = read('.claude-plugin/marketplace.json');
    assert.equal(codex.name, 'steward');
    assert.equal(claude.name, 'steward');
    assert.equal(codex.plugins[0].source.path, './');
    assert.equal(claude.plugins[0].source, './');
    assert(fs.existsSync(path.join(PACKAGE, codex.plugins[0].source.path, 'bin/steward.mjs')));
});
