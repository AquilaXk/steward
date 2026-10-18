import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath, readJSON, atomicWrite, sha256, rootOf } from './fs.mjs';
import { insist } from './errors.mjs';
import { loadBundle } from './trust.mjs';
const AUDIT_LIMIT = 20000;
export function audit(root, host, event, result, bundleHash) {
    root = rootOf(root);
    const id = randomUUID();
    // These are output-preparation receipts. The process cannot observe host/model receipt.
    const row = { version: 1, id, time: new Date().toISOString(), project: sha256(root), host, event: event.event, bundleHash, decision: result.decision,
        matched: result.matched, emitted: result.emitted, omitted: result.omitted, bytes: result.bytes, stage: 'prepared', hostAcknowledged: false };
    const dir = safePath(root, '.steward/state/audit');
    let count = 0;
    try {
        count = fs.readdirSync(dir).length; //NOSONAR
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    insist(count < AUDIT_LIMIT, 'AUDIT_FULL', 'Audit retention limit reached. Archive receipts before continuing.');
    atomicWrite(root, `.steward/state/audit/${id}.json`, JSON.stringify(row) + '\n');
    return id;
}
function readAuditDirectory(dir) {
    try {
        const contents = fs.readdirSync(dir); //NOSONAR
        const names = contents.filter(n => n.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en'));
        return { entries: contents.length, names };
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        return { entries: 0, names: [] };
    }
}
function accumulateCurrentBundleReceipt(r, byId) {
    insist(Array.isArray(r.matched) && Array.isArray(r.omitted) && typeof r.time === 'string' && Number.isFinite(Date.parse(r.time)), 'AUDIT_CORRUPT', 'Invalid current-bundle audit receipt.');
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
export function report(root) {
    root = rootOf(root);
    const dir = safePath(root, '.steward/state/audit');
    const { entries, names } = readAuditDirectory(dir);
    const bundle = loadBundle(root);
    const rules = bundle.policy.rules.map(rule => ({ id: rule.id, effect: rule.effect, matched: 0, emitted: 0, omitted: 0, lastPreparedAt: null }));
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    const counts = Object.create(null);
    let denied = 0;
    let currentReceipts = 0;
    const projectHash = sha256(root);
    for (const name of names) {
        const r = readJSON(safePath(root, `.steward/state/audit/${name}`));
        insist(r.version === 1 && r.project === projectHash && Array.isArray(r.emitted), 'AUDIT_CORRUPT', 'Invalid audit receipt.');
        if (r.decision === 'deny')
            denied++;
        for (const id of r.emitted)
            counts[id] = (counts[id] || 0) + 1;
        if (r.bundleHash !== bundle.hash) continue;
        currentReceipts++;
        accumulateCurrentBundleReceipt(r, byId);
    }
    return { receipts: names.length, denied, emitted: counts, stage: 'prepared', hostAcknowledged: false,
        current: { bundleHash: bundle.hash, receipts: currentReceipts, rules,
            neverEmitted: rules.filter(r => r.effect === 'inject' && r.emitted === 0).map(r => r.id) },
        retention: { limit: AUDIT_LIMIT, remaining: Math.max(0, AUDIT_LIMIT - entries) } };
}
export function pruneAudit(root, { keep = 5000 } = {}) {
    root = rootOf(root);
    insist(Number.isInteger(keep) && keep >= 0, 'USAGE', 'keep must be a non-negative integer.');
    const dir = safePath(root, '.steward/state/audit');
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); //NOSONAR
    }
    catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return { deleted: 0, remaining: 0 };
    }
    if (names.length <= keep)
        return { deleted: 0, remaining: names.length };
    const filesWithStats = names.map(name => {
        const filePath = safePath(root, `.steward/state/audit/${name}`);
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch {} //NOSONAR
        return { name, filePath, mtime };
    }).sort((a, b) => a.mtime - b.mtime);
    const toDelete = filesWithStats.slice(0, filesWithStats.length - keep);
    let deleted = 0;
    for (const item of toDelete) {
        try {
            fs.unlinkSync(item.filePath); //NOSONAR
            deleted++;
        } catch {}
    }
    return { deleted, remaining: names.length - deleted };
}
