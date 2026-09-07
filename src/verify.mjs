import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { requireTrust, loadBundle } from './trust.mjs';
import { snapshot, sha256, atomicWrite, canonical, safePath, readText } from './fs.mjs';
import { appendInternal, readJournal } from './journal.mjs';
import { insist } from './errors.mjs';
function cleanEnvironment() {
    const env = {};
    for (const k of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'])
        if (process.env[k] !== undefined)
            env[k] = process.env[k];
    env.CI = 'true';
    env.NO_COLOR = '1';
    return env;
}
export async function runVerification(root) {
    const { plan, hash: bundleHash } = requireTrust(root), before = snapshot(root);
    const id = randomUUID(), checks = [];
    for (const check of plan.checks) {
        const start = Date.now();
        const command = check.argv[0] === 'node' ? process.execPath : check.argv[0];
        const child = spawnSync(command, check.argv.slice(1), { cwd: root, env: cleanEnvironment(), encoding: 'utf8', shell: false, timeout: check.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
        let status = 'pass', error = null;
        if (child.error) {
            error = child.error.code || 'SPAWN_ERROR';
            status = error === 'ENOENT' ? 'unavailable' : 'fail';
        }
        else if (child.status !== 0 || child.signal) {
            status = 'fail';
            error = child.signal ? 'SIGNAL' : `EXIT_${child.status}`;
        }
        const stdout = child.stdout || '', stderr = child.stderr || '';
        const prefix = `.steward/state/checks/${id}/${check.id}`;
        atomicWrite(root, prefix + '.stdout.txt', stdout);
        atomicWrite(root, prefix + '.stderr.txt', stderr);
        checks.push({ id: check.id, status, error, exitCode: child.status, signal: child.signal || null, durationMs: Date.now() - start,
            stdout: { path: prefix + '.stdout.txt', sha256: sha256(stdout) }, stderr: { path: prefix + '.stderr.txt', sha256: sha256(stderr) } });
    }
    const after = snapshot(root), unchanged = before.hash === after.hash;
    const report = { version: 1, runId: id, bundleHash, planHash: sha256(canonical(plan)), workspace: before, workspaceAfter: after.hash,
        sourceUnchanged: unchanged, runtime: { node: process.version, platform: process.platform, arch: process.arch }, checks,
        allPassed: unchanged && checks.every(c => c.status === 'pass'), limitations: ['Commands execute with local user privileges.', 'Recorded output may contain sensitive test data.', 'node_modules and external services are outside the source snapshot.'] };
    const record = await appendInternal(root, 'verification', report);
    return { ...report, evidence: record.hash };
}
export function completionGate(root, evidence = null) {
    const bundle = requireTrust(root), rows = readJournal(root);
    const row = evidence ? rows.find(r => r.hash === evidence) : rows.findLast(r => r.type === 'verification');
    insist(row && row.type === 'verification', 'NO_EVIDENCE', 'No verification evidence exists for this project.');
    const r = row.data;
    insist(r.allPassed === true && r.sourceUnchanged === true && Array.isArray(r.checks) && r.checks.length > 0 && r.checks.every(c => c.status === 'pass'), 'CHECKS_FAILED', 'Verification did not pass every required check.');
    insist(r.bundleHash === bundle.hash && r.planHash === sha256(canonical(bundle.plan)), 'STALE_PLAN', 'Verification used a different approved plan.');
    insist(r.checks.length === bundle.plan.checks.length && r.checks.every((c, i) => c.id === bundle.plan.checks[i].id), 'CHECKS_INCOMPLETE', 'Evidence does not cover the required checks.');
    for (const check of r.checks) {
        for (const stream of ['stdout', 'stderr']) {
            const artifact = check[stream];
            insist(artifact && typeof artifact.path === 'string' && artifact.path.startsWith('.steward/state/checks/'), 'BAD_EVIDENCE', 'Invalid output reference.');
            let content;
            try {
                content = readText(safePath(root, artifact.path), 2 * 1024 * 1024);
            }
            catch {
                insist(false, 'OUTPUT_CHANGED', 'A verification output is missing or unreadable.');
            }
            insist(sha256(content) === artifact.sha256, 'OUTPUT_CHANGED', 'A verification output changed after capture.');
        }
    }
    insist(r.runtime.node === process.version && r.runtime.platform === process.platform && r.runtime.arch === process.arch, 'STALE_RUNTIME', 'Runtime differs from the verified runtime.');
    const age = (Date.now() - Date.parse(row.time)) / 1000;
    insist(Number.isFinite(age) && age >= 0 && age <= bundle.plan.maxAgeSeconds, 'STALE_EVIDENCE', 'Verification is outside the plan freshness window.');
    insist(snapshot(root).hash === r.workspace.hash, 'STALE_SOURCE', 'Source files changed after verification.');
    return { pass: true, evidence: row.hash, scope: 'Approved local checks on this source snapshot and runtime. Not deployment or semantic proof.', workspace: r.workspace.hash };
}
