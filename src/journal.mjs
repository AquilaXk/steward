import { randomUUID } from 'node:crypto';
import { mkdir, sha256, canonical, atomicWrite, withLock, rootOf, toSessionHash } from './fs.mjs';
import { validateEntry, validateJournalRow } from './schema.mjs';
import { insist } from './errors.mjs';
import { syncJournalCache, queryJournalIndexed } from './index-cache.mjs';
const DIRECTORY = '.steward/state/journal';
export function readJournal(root, { anchor = null, fresh = false } = {}) {
    const { rows } = syncJournalCache(root, { fresh });
    if (anchor) {
        insist(Number.isInteger(anchor.count) && anchor.count >= 0, 'BAD_ANCHOR', 'Invalid journal anchor.');
        const actual = anchor.count === 0 ? null : rows[anchor.count - 1]?.hash;
        insist(rows.length >= anchor.count && actual === anchor.head, 'ANCHOR_MISMATCH', 'Journal disagrees with the retained external anchor.');
    }
    return rows;
}
export function journalHead(rows) {
    return {
        count: rows.length,
        head: rows.at(-1)?.hash || null
    };
}
export function queryJournal(root, options = {}) {
    return queryJournalIndexed(root, options);
}
export async function appendInternal(root, type, data) {
    root = rootOf(root);
    mkdir(root, DIRECTORY);
    return withLock(root, '.steward/state/journal.lock', () => {
        const { rows, cache } = syncJournalCache(root);
        if (type === 'schedule' && data.id && !data.supersedes) {
            const existing = cache.index.byRecordId.get(data.id);
            insist(!existing?.some(r => r.type === 'schedule'), 'BAD_SUPERSEDE', 'Schedule identity already exists; supersede its latest record.');
        }
        if (data.supersedes) {
            const old = cache.index.byHash.get(data.supersedes);
            insist(old && old.type === type, 'BAD_SUPERSEDE', 'Superseded record must exist and have the same type.');
            if (type === 'schedule') {
                insist(old.data.id === data.id, 'BAD_SUPERSEDE', 'Schedule revision must preserve identity.');
            }
            insist(!cache.index.supersededHashes.has(old.hash), 'BAD_SUPERSEDE', 'That record has already been superseded.');
        }
        const payload = {
            version: 1,
            seq: rows.length + 1,
            id: randomUUID(),
            type,
            time: new Date().toISOString(),
            previous: rows.at(-1)?.hash || null,
            data
        };
        const row = { ...payload, hash: sha256(canonical(payload)) };
        validateJournalRow(row);
        atomicWrite(root, `${DIRECTORY}/${String(row.seq).padStart(8, '0')}-${row.id}.json`, JSON.stringify(row, null, 2) + '\n');
        return row;
    });
}
export async function appendEntry(root, entry) {
    root = rootOf(root);
    validateEntry(entry);
    if (entry.type === 'goal' && entry.data.status === 'complete') {
        const { completionGate } = await import('./verify.mjs');
        for (const evidence of entry.data.evidence)
            completionGate(root, evidence);
    }
    return appendInternal(root, entry.type, entry.data);
}
export function latestCheckpoint(root, sessionId = null) {
    const { cache } = syncJournalCache(root);
    const session = toSessionHash(sessionId);
    return cache.index.bySession.get(session)?.at(-1) || null;
}
export function saveCompaction(root, sessionId) {
    root = rootOf(root);
    const { rows, cache } = syncJournalCache(root);
    const session = toSessionHash(sessionId);
    const checkpoint = cache.index.bySession.get(session)?.at(-1) || null;
    const head = journalHead(rows);
    const record = {
        version: 1,
        time: new Date().toISOString(),
        session,
        ...head,
        checkpoint: checkpoint ? { hash: checkpoint.hash, data: checkpoint.data } : null,
        conversationCaptured: false
    };
    const relative = `.steward/state/checkpoints/${randomUUID()}.json`;
    atomicWrite(root, relative, JSON.stringify(record, null, 2) + '\n');
    return {
        path: relative,
        ...head,
        hasCheckpoint: !!checkpoint
    };
}
