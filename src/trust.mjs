import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safePath, readText, parseJSON, sha256, canonical, atomicWrite, rootOf } from './fs.mjs';
import { validatePolicy, validatePlan } from './schema.mjs';
import { insist } from './errors.mjs';
export function loadBundle(root) {
    const policyPath = safePath(root, '.steward/policy.json'), planPath = safePath(root, '.steward/verify.json');
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
export const projectKey = (root) => sha256(root);
export function trustBundle(root, digest) {
    root = rootOf(root);
    const bundle = loadBundle(root);
    insist(digest === bundle.hash, 'APPROVAL_MISMATCH', 'Approval must name the exact reviewed bundle hash.');
    const home = trustHome();
    const relative = path.relative(root, home);
    insist(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'TRUST_LOCATION', 'Trust records must be stored outside the project.');
    atomicWrite(home, `trust/${projectKey(root)}.json`, JSON.stringify({ version: 1, project: projectKey(root), bundleHash: bundle.hash, approvedAt: new Date().toISOString() }, null, 2) + '\n', { replace: true });
    return { trusted: true, bundleHash: bundle.hash };
}
export function requireTrust(root) {
    root = rootOf(root);
    const home = trustHome(), relative = path.relative(root, home);
    insist(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'TRUST_LOCATION', 'Trust records must be stored outside the project.');
    const bundle = loadBundle(root);
    let saved;
    try {
        saved = parseJSON(readText(safePath(home, `trust/${projectKey(root)}.json`)), 'trust record');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            insist(false, 'UNTRUSTED', 'Review and approve this project policy and verification plan with steward trust.');
        throw e;
    }
    insist(saved.version === 1 && saved.project === projectKey(root) && saved.bundleHash === bundle.hash, 'TRUST_CHANGED', 'Policy or verification commands changed after review. No action was allowed.');
    return bundle;
}
