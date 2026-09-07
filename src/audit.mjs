import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath, readJSON, atomicWrite, sha256 } from './fs.mjs';
import { insist } from './errors.mjs';
import { loadBundle } from './trust.mjs';
const AUDIT_LIMIT = 20000;
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
    insist(count < AUDIT_LIMIT, 'AUDIT_FULL', 'Audit retention limit reached. Archive receipts before continuing.');
    atomicWrite(root, `.steward/state/audit/${id}.json`, JSON.stringify(row) + '\n');
    return id;
}
export function report(root) {
    const dir = safePath(root, '.steward/state/audit');
    let names = [];
    let entries = 0;
    try {
        const contents = fs.readdirSync(dir);
        entries = contents.length;
        names = contents.filter(n => n.endsWith('.json'));
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const bundle = loadBundle(root);
    const rules = bundle.policy.rules.map(rule => ({ id: rule.id, effect: rule.effect, matched: 0, emitted: 0, omitted: 0, lastPreparedAt: null }));
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    const counts = {};
    let denied = 0;
    let currentReceipts = 0;
    for (const name of names) {
        const r = readJSON(safePath(root, `.steward/state/audit/${name}`));
        insist(r.version === 1 && r.project === sha256(root) && Array.isArray(r.emitted), 'AUDIT_CORRUPT', 'Invalid audit receipt.');
        if (r.decision === 'deny')
            denied++;
        for (const id of r.emitted)
            counts[id] = (counts[id] || 0) + 1;
        if (r.bundleHash !== bundle.hash) continue;
        insist(Array.isArray(r.matched) && Array.isArray(r.omitted) && typeof r.time === 'string' && Number.isFinite(Date.parse(r.time)), 'AUDIT_CORRUPT', 'Invalid current-bundle audit receipt.');
        currentReceipts++;
        for (const id of r.matched) {
            insist(byId.has(id), 'AUDIT_CORRUPT', 'Receipt refers to an unknown current rule.');
            byId.get(id).matched++;
        }
        for (const id of r.emitted) {
            insist(byId.has(id), 'AUDIT_CORRUPT', 'Receipt refers to an unknown current rule.');
            const rule = byId.get(id);
            rule.emitted++;
            if (rule.lastPreparedAt === null || r.time > rule.lastPreparedAt) rule.lastPreparedAt = r.time;
        }
        for (const item of r.omitted) {
            insist(byId.has(item?.id), 'AUDIT_CORRUPT', 'Receipt refers to an unknown omitted rule.');
            byId.get(item.id).omitted++;
        }
    }
    return { receipts: names.length, denied, emitted: counts, stage: 'prepared', hostAcknowledged: false,
        current: { bundleHash: bundle.hash, receipts: currentReceipts, rules,
            neverEmitted: rules.filter(r => r.effect === 'inject' && r.emitted === 0).map(r => r.id) },
        retention: { limit: AUDIT_LIMIT, remaining: Math.max(0, AUDIT_LIMIT - entries) } };
}
