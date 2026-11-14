import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { requireTrust } from './trust.mjs';
import { snapshot, sha256, atomicWrite, canonical, safePath, readText, rootOf } from './fs.mjs';
import { appendInternal } from './journal.mjs';
import { syncJournalCache } from './index-cache.mjs';
import { insist } from './errors.mjs';
const CLEAN_ENV_KEYS = [
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'
];
const VERIFICATION_LIMITATIONS = [
    'Commands execute with local user privileges.',
    'Recorded output may contain sensitive test data.',
    'node_modules and external services are outside the source snapshot.'
];
function cleanEnvironment() {
    const env = {};
    for (const k of CLEAN_ENV_KEYS) {
        if (process.env[k] !== undefined) {
            env[k] = process.env[k];
        }
    }
    env.CI = 'true';
    env.NO_COLOR = '1';
    return env;
}
function probeWindowsCandidate(dir, cmd, extensions) {
    for (const ext of extensions) {
        const candidate = path.join(dir, cmd + ext);
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {}
    }
    return null;
}
function isBareWindowsCommand(cmd) {
    return process.platform === 'win32' && !path.extname(cmd) && !cmd.includes('/') && !cmd.includes('\\');
}
export function resolveCommand(cmd, env = {}) {
    if (cmd === 'node') return process.execPath;
    if (!isBareWindowsCommand(cmd)) return cmd;
    const rawExts = (env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const extensions = [...new Set(rawExts.flatMap(ext => [ext, ext.toLowerCase(), ext.toUpperCase()]))];
    const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
    const pathDirs = (env.PATH || process.env.PATH || '').split(delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const hit = probeWindowsCandidate(dir, cmd, extensions);
        if (hit) return hit;
    }
    return cmd;
}
export function resolveSpawnSpec(argv, env = process.env, nodeDirOverride = path.dirname(process.execPath)) {
    const cmd = argv[0];
    const args = argv.slice(1);
    if (process.platform === 'win32' && typeof cmd === 'string') {
        const bare = !cmd.includes('/') && !cmd.includes('\\');
        const lower = cmd.toLowerCase();
        if (bare && (lower === 'npm' || lower === 'npm.cmd' || lower === 'npx' || lower === 'npx.cmd')) {
            const cliName = lower.startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
            const cliJs = path.join(nodeDirOverride, 'node_modules/npm/bin', cliName);
            if (fs.existsSync(cliJs)) {
                return { file: process.execPath, args: [cliJs, ...args] };
            }
        }
    }
    return { file: resolveCommand(cmd, env), args };
}
function execCheckAsync(file, args, { cwd, env, timeoutMs, maxBuffer }) {
    return new Promise((resolve) => {
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let streamError = null;
        let spawnError = null;
        let timedOut = false;
        let settled = false;

        let child;
        try {
            child = spawn(file, args, {
                cwd,
                env,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            const code = err?.code === 'EINVAL' && process.platform === 'win32'
                ? 'EINVAL_BATCH_SCRIPT'
                : (err?.code || 'SPAWN_ERROR');
            resolve({ error: { code }, status: null, signal: null, stdout: '', stderr: '' });
            return;
        }

        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const finalErr = spawnError || streamError || (timedOut ? { code: 'ETIMEDOUT' } : null);
            const finalSignal = signal || ((timedOut || streamError) ? 'SIGKILL' : null);
            resolve({
                error: finalErr,
                status: finalErr ? null : code,
                signal: finalSignal,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8')
            });
        };

        const abortChild = () => {
            try { child.kill('SIGKILL'); } catch {}
            try { child.stdout.destroy(); } catch {}
            try { child.stderr.destroy(); } catch {}
        };

        const timer = setTimeout(() => {
            timedOut = true;
            abortChild();
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            if (streamError) return;
            if (stdoutBytes + chunk.length > maxBuffer) {
                streamError = { code: 'ENOBUFS' };
                abortChild();
                return;
            }
            stdoutChunks.push(chunk);
            stdoutBytes += chunk.length;
        });

        child.stderr.on('data', (chunk) => {
            if (streamError) return;
            if (stderrBytes + chunk.length > maxBuffer) {
                streamError = { code: 'ENOBUFS' };
                abortChild();
                return;
            }
            stderrChunks.push(chunk);
            stderrBytes += chunk.length;
        });

        child.on('error', (err) => {
            const code = err?.code === 'EINVAL' && process.platform === 'win32'
                ? 'EINVAL_BATCH_SCRIPT'
                : (err?.code || 'SPAWN_ERROR');
            spawnError = { code };
            finish(null, null);
        });

        child.on('close', (code, signal) => {
            finish(code, signal);
        });
    });
}
export async function runVerification(root) {
    root = rootOf(root);
    const { plan, hash: bundleHash } = requireTrust(root);
    const before = snapshot(root, plan.exclude || []);
    const id = randomUUID();
    const checks = [];
    const env = cleanEnvironment();
    for (const check of plan.checks) {
        const start = Date.now();
        const spec = resolveSpawnSpec(check.argv, env);
        const child = await execCheckAsync(spec.file, spec.args, {
            cwd: root,
            env,
            timeoutMs: check.timeoutMs,
            maxBuffer: 1024 * 1024
        });
        let status = 'pass';
        let error = null;
        if (child.error) {
            error = child.error.code || 'SPAWN_ERROR';
            status = error === 'ENOENT' ? 'unavailable' : 'fail';
        } else if (child.status !== 0 || child.signal) {
            status = 'fail';
            error = child.signal ? 'SIGNAL' : `EXIT_${child.status}`;
        }
        const stdout = child.stdout || '';
        const stderr = child.stderr || '';
        const prefix = `.steward/state/checks/${id}/${check.id}`;
        atomicWrite(root, prefix + '.stdout.txt', stdout);
        atomicWrite(root, prefix + '.stderr.txt', stderr);
        checks.push({
            id: check.id,
            status,
            error,
            exitCode: child.status,
            signal: child.signal || null,
            durationMs: Date.now() - start,
            stdout: { path: prefix + '.stdout.txt', sha256: sha256(stdout) },
            stderr: { path: prefix + '.stderr.txt', sha256: sha256(stderr) }
        });
    }
    const after = snapshot(root, plan.exclude || []);
    const unchanged = before.hash === after.hash;
    const report = {
        version: 1,
        runId: id,
        bundleHash,
        planHash: sha256(canonical(plan)),
        workspace: before,
        workspaceAfter: after.hash,
        sourceUnchanged: unchanged,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        checks,
        allPassed: unchanged && checks.every(c => c.status === 'pass'),
        limitations: VERIFICATION_LIMITATIONS
    };
    const record = await appendInternal(root, 'verification', report);
    return { ...report, evidence: record.hash, evidenceHash: record.hash };
}
export function verifyCompletionGateBatch(root, evidenceHashes, preloaded = null) {
    root = rootOf(root);
    if (!Array.isArray(evidenceHashes) || evidenceHashes.length === 0) {
        return [];
    }
    const bundle = preloaded?.bundle ?? requireTrust(root);
    const { cache } = preloaded?.cache ? preloaded : syncJournalCache(root, { fresh: true });
    const expectedPlanHash = sha256(canonical(bundle.plan));
    const verifiedArtifacts = new Map();
    const verifiedResults = new Map();
    let currentSnapshotHash = null;
    const nowMs = Date.now();
    const out = new Array(evidenceHashes.length);

    for (let idx = 0; idx < evidenceHashes.length; idx++) {
        const evidence = evidenceHashes[idx];
        if (typeof evidence === 'string' && verifiedResults.has(evidence)) {
            out[idx] = verifiedResults.get(evidence);
            continue;
        }
        const row = evidence ? cache.index.byHash.get(evidence) : null;
        insist(row && row.type === 'verification', 'NO_EVIDENCE', 'No verification evidence exists for this project.');
        const r = row.data;
        insist(r.allPassed === true && r.sourceUnchanged === true && Array.isArray(r.checks) && r.checks.length > 0 && r.checks.every(c => c.status === 'pass'), 'CHECKS_FAILED', 'Verification did not pass every required check.');
        insist(r.bundleHash === bundle.hash && r.planHash === expectedPlanHash, 'STALE_PLAN', 'Verification used a different approved plan.');
        insist(r.checks.length === bundle.plan.checks.length && r.checks.every((c, i) => c.id === bundle.plan.checks[i].id), 'CHECKS_INCOMPLETE', 'Evidence does not cover the required checks.');
        for (const check of r.checks) {
            for (const stream of ['stdout', 'stderr']) {
                const artifact = check[stream];
                insist(artifact && typeof artifact.path === 'string' && artifact.path.startsWith('.steward/state/checks/'), 'BAD_EVIDENCE', 'Invalid output reference.');
                let actualHash = verifiedArtifacts.get(artifact.path);
                if (actualHash === undefined) {
                    let content;
                    try {
                        content = readText(safePath(root, artifact.path), 2 * 1024 * 1024);
                    } catch {
                        insist(false, 'OUTPUT_CHANGED', 'A verification output is missing or unreadable.');
                    }
                    actualHash = sha256(content);
                    verifiedArtifacts.set(artifact.path, actualHash);
                }
                insist(actualHash === artifact.sha256, 'OUTPUT_CHANGED', 'A verification output changed after capture.');
            }
        }
        insist(r.runtime.node === process.version && r.runtime.platform === process.platform && r.runtime.arch === process.arch, 'STALE_RUNTIME', 'Runtime differs from the verified runtime.');
        const age = (nowMs - Date.parse(row.time)) / 1000;
        insist(Number.isFinite(age) && age >= 0 && age <= bundle.plan.maxAgeSeconds, 'STALE_EVIDENCE', 'Verification is outside the plan freshness window.');
        if (currentSnapshotHash === null) {
            currentSnapshotHash = snapshot(root, bundle.plan.exclude || []).hash;
        }
        insist(currentSnapshotHash === r.workspace.hash, 'STALE_SOURCE', 'Source files changed after verification.');
        const result = { pass: true, evidence: row.hash, evidenceHash: row.hash, scope: 'Approved local checks on this source snapshot and runtime. Not deployment or semantic proof.', workspace: r.workspace.hash };
        verifiedResults.set(row.hash, result);
        out[idx] = result;
    }
    return out;
}
export function completionGate(root, evidence = null) {
    root = rootOf(root);
    const bundle = requireTrust(root);
    const { cache } = syncJournalCache(root, { fresh: true });
    const targetHash = evidence ?? cache.index.byType.get('verification')?.at(-1)?.hash;
    insist(typeof targetHash === 'string' && targetHash.length > 0, 'NO_EVIDENCE', 'No verification evidence exists for this project.');
    return verifyCompletionGateBatch(root, [targetHash], { bundle, cache })[0];
}
