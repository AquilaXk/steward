import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath, readJSON, atomicWrite, sha256 } from './fs.mjs';
import { insist } from './errors.mjs';
export function audit(root, host, event, result, bundleHash) {
    const id = randomUUID();
    // These are output-preparation receipts. The process cannot observe host/model receipt.
    const row = { version: 1, id, time: new Date().toISOString(), project: sha256(root), host, event: event.event, bundleHash, decision: result.decision,
        matched: result.matched, emitted: result.emitted, omitted: result.omitted, bytes: result.bytes, stage: 'prepared', hostAcknowledged: false };
    const dir = safePath(root, '.steward/state/audit');
    let count = 0;
    try {
        count = fs.readdirSync(dir).length;
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    insist(count < 20000, 'AUDIT_FULL', 'Audit retention limit reached. Archive receipts before continuing.');
    atomicWrite(root, `.steward/state/audit/${id}.json`, JSON.stringify(row) + '\n');
    return id;
}
export function report(root) {
    const dir = safePath(root, '.steward/state/audit');
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const counts = {};
    let denied = 0;
    for (const name of names) {
        const r = readJSON(safePath(root, `.steward/state/audit/${name}`));
        insist(r.version === 1 && r.project === sha256(root) && Array.isArray(r.emitted), 'AUDIT_CORRUPT', 'Invalid audit receipt.');
        if (r.decision === 'deny')
            denied++;
        for (const id of r.emitted)
            counts[id] = (counts[id] || 0) + 1;
    }
    return { receipts: names.length, denied, emitted: counts, stage: 'prepared', hostAcknowledged: false };
}
