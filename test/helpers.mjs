import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/setup.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
export const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function sandbox(t, { trusted = true, plan = null } = {}) {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-test-')));
    const root = path.join(temp, 'project');
    const previous = process.env.STEWARD_TRUST_HOME;
    process.env.STEWARD_TRUST_HOME = path.join(temp, 'trust');
    t.after(() => {
        fs.rmSync(temp, { recursive: true, force: true });
        if (previous === undefined)
            delete process.env.STEWARD_TRUST_HOME;
        else
            process.env.STEWARD_TRUST_HOME = previous;
    });
    initProject(root);
    if (plan)
        write(root, '.steward/verify.json', plan);
    if (trusted)
        trustBundle(root, loadBundle(root).hash);
    return { root, temp, trustHome: process.env.STEWARD_TRUST_HOME };
}
export function write(root, relative, value) { const p = path.join(root, relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
export function cli(root, args, input) { return spawnSync(process.execPath, [path.join(PACKAGE, 'bin/steward.mjs'), ...args, '--project', root], { encoding: 'utf8', input: typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input), env: process.env, timeout: 15000 }); }
export const event = (text = 'hello') => ({ event: 'prompt', text, tool: null, paths: [], sessionId: null });
export const rule = (extra = {}) => ({ id: 'example', on: ['prompt'], effect: 'inject', priority: 100, body: 'Use evidence.', required: false, match: { always: true }, ...extra });
export const policy = (rules, budget = { bytes: 6000, rules: 12 }) => ({ version: 1, budget, rules });
export const plan = (code = 'process.exit(0)', extra = {}) => ({ version: 1, maxAgeSeconds: 3600, checks: [{ id: 'focused', description: 'A controlled verification fixture.', argv: ['node', '-e', code], timeoutMs: 2000, ...extra }] });
export const checkpoint = { type: 'checkpoint', data: { summary: 'Parser fixed; local test passed.', next: 'Check the consumer contract.', blockers: [] } };
