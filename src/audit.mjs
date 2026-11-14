import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath, readJSON, atomicWrite, sha256, rootOf, compareAscii } from './fs.mjs';
import { insist } from './errors.mjs';
import { loadBundle } from './trust.mjs';
const AUDIT_LIMIT = 20000;
const RECEIPT_CACHE_LIMIT = 4096;
const auditCountCache = new Map();
const receiptSummaryCache = new Map();

function readCachedAuditCount(root, dir) {
    let stat;
    try {
        stat = fs.statSync(dir); //NOSONAR
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        auditCountCache.delete(root);
        return { count: 0, stat: null };
    }
    const cached = auditCountCache.get(root);
    if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs &&
        cached.ino === stat.ino
    ) {
        return { count: cached.count, stat };
    }
    const count = fs.readdirSync(dir).length; //NOSONAR
    auditCountCache.set(root, {
        count,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino
    });
    return { count, stat };
}

function recordAuditIncrement(root, dir, nextCount) {
    try {
        const afterStat = fs.statSync(dir); //NOSONAR
        auditCountCache.set(root, {
            count: nextCount,
            mtimeMs: afterStat.mtimeMs,
            ctimeMs: afterStat.ctimeMs,
            ino: afterStat.ino
        });
    } catch {
        auditCountCache.delete(root);
    }
}

export function audit(root, host, event, result, bundleHash) {
    root = rootOf(root);
    const id = randomUUID();
    // These are output-preparation receipts. The process cannot observe host/model receipt.
    const row = {
        version: 1,
        id,
        time: new Date().toISOString(),
        project: sha256(root),
        host,
        event: event.event,
        bundleHash,
        decision: result.decision,
        matched: result.matched,
        emitted: result.emitted,
        omitted: result.omitted,
        bytes: result.bytes,
        stage: 'prepared',
        hostAcknowledged: false
    };
    const dir = safePath(root, '.steward/state/audit');
    const { count } = readCachedAuditCount(root, dir);
    insist(count < AUDIT_LIMIT, 'AUDIT_FULL', 'Audit retention limit reached. Archive receipts before continuing.');
    atomicWrite(root, `.steward/state/audit/${id}.json`, JSON.stringify(row) + '\n');
    recordAuditIncrement(root, dir, count + 1);
    return id;
}
function readAuditDirectory(dir) {
    try {
        const contents = fs.readdirSync(dir); //NOSONAR
        const names = contents.filter(n => n.endsWith('.json')).sort(compareAscii);
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
function readReceiptSummary(dir, name) {
    insist(path.basename(name) === name && !name.includes('\0'), 'BAD_PATH', 'Invalid audit receipt filename.');
    const filePath = path.join(dir, name);
    const stat = fs.lstatSync(filePath); //NOSONAR
    insist(stat.isFile() && !stat.isSymbolicLink(), 'SYMLINK', `Refusing symbolic link: ${name}`);
    const cached = receiptSummaryCache.get(filePath);
    if (
        cached &&
        cached.ino === stat.ino &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs
    ) {
        return cached.summary;
    }
    const r = readJSON(filePath);
    const summary = {
        version: r.version,
        project: r.project,
        bundleHash: r.bundleHash,
        decision: r.decision,
        time: r.time,
        matched: r.matched,
        emitted: r.emitted,
        omitted: r.omitted
    };
    if (!receiptSummaryCache.has(filePath) && receiptSummaryCache.size >= RECEIPT_CACHE_LIMIT) {
        receiptSummaryCache.delete(receiptSummaryCache.keys().next().value);
    }
    receiptSummaryCache.set(filePath, {
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        summary
    });
    return summary;
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
        const r = readReceiptSummary(dir, name);
        insist(r.version === 1 && r.project === projectHash && Array.isArray(r.emitted), 'AUDIT_CORRUPT', 'Invalid audit receipt.');
        if (r.decision === 'deny')
            denied++;
        for (const id of r.emitted)
            counts[id] = (counts[id] || 0) + 1;
        if (r.bundleHash !== bundle.hash) continue;
        currentReceipts++;
        accumulateCurrentBundleReceipt(r, byId);
    }
    return {
        receipts: names.length,
        denied,
        emitted: counts,
        stage: 'prepared',
        hostAcknowledged: false,
        current: {
            bundleHash: bundle.hash,
            receipts: currentReceipts,
            rules,
            neverEmitted: rules.filter(r => r.effect === 'inject' && r.emitted === 0).map(r => r.id)
        },
        retention: {
            limit: AUDIT_LIMIT,
            remaining: Math.max(0, AUDIT_LIMIT - entries)
        }
    };
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
        insist(path.basename(name) === name && !name.includes('\0'), 'BAD_PATH', 'Invalid audit receipt filename.');
        const filePath = path.join(dir, name);
        let mtime = 0;
        try {
            const stat = fs.lstatSync(filePath); //NOSONAR
            insist(!stat.isSymbolicLink(), 'SYMLINK', `Refusing symbolic link: ${name}`);
            mtime = stat.mtimeMs;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        return { name, filePath, mtime };
    }).sort((a, b) => (a.mtime - b.mtime) || compareAscii(a.name, b.name));
    const toDelete = filesWithStats.slice(0, filesWithStats.length - keep);
    let deleted = 0;
    for (const item of toDelete) {
        try {
            fs.unlinkSync(item.filePath); //NOSONAR
            receiptSummaryCache.delete(item.filePath);
            deleted++;
        } catch {}
    }
    auditCountCache.delete(root);
    return { deleted, remaining: names.length - deleted };
}
