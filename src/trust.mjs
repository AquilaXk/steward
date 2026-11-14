import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safePath, readText, parseJSON, sha256, canonical, atomicWrite, rootOf, deepFreeze } from './fs.mjs';
import { validatePolicy, validatePlan } from './schema.mjs';
import { insist } from './errors.mjs';

const TRUST_CACHE_LIMIT = 128;
const trustCache = new Map();

function statTupleMatches(st, saved) {
    return st.ino === saved.ino && st.size === saved.size && st.mtimeNs === saved.mtimeNs && st.ctimeNs === saved.ctimeNs;
}

function captureStatTuple(st) {
    return { ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
}

export function loadBundle(root) {
    root = rootOf(root);
    const policyPath = safePath(root, '.steward/policy.json');
    const planPath = safePath(root, '.steward/verify.json');
    const policy = validatePolicy(parseJSON(readText(policyPath), 'policy.json'));
    const plan = validatePlan(parseJSON(readText(planPath), 'verify.json'));
    const hash = sha256(canonical({ policy, plan }));
    return { policy, plan, hash, policyPath, planPath };
}
export function trustHome() {
    const home = path.resolve(process.env.STEWARD_TRUST_HOME || path.join(os.homedir(), '.config', 'steward'));
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return rootOf(home);
}
export function projectKey(root) {
    return sha256(root);
}
function resolveTrustHomeOutsideProject(root) {
    const home = trustHome();
    const relative = path.relative(root, home);
    const isOutside = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
    insist(isOutside, 'TRUST_LOCATION', 'Trust records must be stored outside the project.');
    return home;
}
export function trustBundle(root, digest) {
    root = rootOf(root);
    const bundle = loadBundle(root);
    insist(digest === bundle.hash, 'APPROVAL_MISMATCH', 'Approval must name the exact reviewed bundle hash.');
    const home = resolveTrustHomeOutsideProject(root);
    const key = projectKey(root);
    const record = {
        version: 1,
        project: key,
        bundleHash: bundle.hash,
        approvedAt: new Date().toISOString()
    };
    atomicWrite(home, `trust/${key}.json`, JSON.stringify(record, null, 2) + '\n', { replace: true });
    trustCache.delete(`${home}\0${root}`);
    return { trusted: true, bundleHash: bundle.hash };
}
export function requireTrust(root) {
    root = rootOf(root);
    const home = resolveTrustHomeOutsideProject(root);
    const key = projectKey(root);
    const cacheKey = `${home}\0${root}`;
    const policyPath = safePath(root, '.steward/policy.json');
    const planPath = safePath(root, '.steward/verify.json');
    const trustPath = safePath(home, `trust/${key}.json`);

    let pStat = null;
    let vStat = null;
    let tStat = null;
    try {
        pStat = fs.lstatSync(policyPath, { bigint: true });
        vStat = fs.lstatSync(planPath, { bigint: true });
        tStat = fs.lstatSync(trustPath, { bigint: true });
    } catch {
        // Fall through to canonical validation/UNTRUSTED error paths below.
    }

    if (pStat && vStat && tStat && !pStat.isSymbolicLink() && !vStat.isSymbolicLink() && !tStat.isSymbolicLink()) {
        const cached = trustCache.get(cacheKey);
        if (
            cached !== undefined &&
            statTupleMatches(pStat, cached.p) &&
            statTupleMatches(vStat, cached.v) &&
            statTupleMatches(tStat, cached.t)
        ) {
            return cached.frozenBundle;
        }
    }

    const bundle = loadBundle(root);
    let saved;
    try {
        saved = parseJSON(readText(trustPath), 'trust record');
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'MISSING_FILE') {
            insist(false, 'UNTRUSTED', 'Review and approve this project policy and verification plan with steward trust.');
        }
        throw e;
    }
    const valid = saved.version === 1 && saved.project === key && saved.bundleHash === bundle.hash;
    insist(valid, 'TRUST_CHANGED', 'Policy or verification commands changed after review. No action was allowed.');

    const frozenBundle = deepFreeze(bundle);
    if (pStat && vStat && tStat && !pStat.isSymbolicLink() && !vStat.isSymbolicLink() && !tStat.isSymbolicLink()) {
        if (trustCache.size >= TRUST_CACHE_LIMIT) {
            trustCache.delete(trustCache.keys().next().value);
        }
        trustCache.set(cacheKey, {
            p: captureStatTuple(pStat),
            v: captureStatTuple(vStat),
            t: captureStatTuple(tStat),
            frozenBundle
        });
    }
    return frozenBundle;
}
