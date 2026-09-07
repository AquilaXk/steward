import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath, mkdir, readJSON, sha256, canonical, atomicWrite, withLock } from './fs.mjs';
import { validateEntry, validateJournalRow } from './schema.mjs';
import { insist } from './errors.mjs';
const DIRECTORY = '.steward/state/journal';
export function readJournal(root, { anchor = null } = {}) {
    const dir = safePath(root, DIRECTORY);
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(n => !n.startsWith('.tmp-')).sort();
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const rows = [];
    let previous = null;
    for (const name of names) {
        insist(/^\d{8}-[a-f0-9-]+\.json$/.test(name), 'JOURNAL_CORRUPT', 'Unexpected file in journal.');
        const row = readJSON(safePath(root, `${DIRECTORY}/${name}`), 4 * 1024 * 1024);
        try { validateJournalRow(row); }
        catch { insist(false, 'JOURNAL_CORRUPT', `Invalid journal record at sequence ${rows.length + 1}.`); }
        const { hash, ...payload } = row;
        insist(row.seq === rows.length + 1 && row.previous === previous && hash === sha256(canonical(payload)), 'JOURNAL_CORRUPT', `Journal integrity check failed at record ${rows.length + 1}.`);
        insist(name === `${String(row.seq).padStart(8, '0')}-${row.id}.json`, 'JOURNAL_CORRUPT', 'Journal filename identity mismatch.');
        rows.push(row);
        previous = hash;
    }
    if (anchor) {
        insist(Number.isInteger(anchor.count) && anchor.count >= 0, 'BAD_ANCHOR', 'Invalid journal anchor.');
        const actual = anchor.count === 0 ? null : rows[anchor.count - 1]?.hash;
        insist(rows.length >= anchor.count && actual === anchor.head, 'ANCHOR_MISMATCH', 'Journal disagrees with the retained external anchor.');
    }
    return rows;
}
export function journalHead(rows) { return { count: rows.length, head: rows.at(-1)?.hash || null }; }
export async function appendInternal(root, type, data) {
    mkdir(root, DIRECTORY);
    return withLock(root, '.steward/state/journal.lock', () => {
        const rows = readJournal(root);
        if (data.supersedes) {
            const old = rows.find(r => r.hash === data.supersedes);
            insist(old && old.type === type, 'BAD_SUPERSEDE', 'Superseded record must exist and have the same type.');
            insist(!rows.some(r => r.data.supersedes === old.hash), 'BAD_SUPERSEDE', 'That record has already been superseded.');
        }
        const payload = { version: 1, seq: rows.length + 1, id: randomUUID(), type, time: new Date().toISOString(), previous: rows.at(-1)?.hash || null, data };
        const row = { ...payload, hash: sha256(canonical(payload)) };
        validateJournalRow(row);
        atomicWrite(root, `${DIRECTORY}/${String(row.seq).padStart(8, '0')}-${row.id}.json`, JSON.stringify(row, null, 2) + '\n');
        return row;
    });
}
export async function appendEntry(root, entry) {
    validateEntry(entry);
    if (entry.type === 'goal' && entry.data.status === 'complete') {
        const { completionGate } = await import('./verify.mjs');
        for (const evidence of entry.data.evidence)
            completionGate(root, evidence);
    }
    return appendInternal(root, entry.type, entry.data);
}
function selectCheckpoint(rows, sessionId) {
    const session = sessionId == null ? null : sha256(sessionId);
    return rows.findLast(r => r.type === 'checkpoint' && (r.data.session ?? null) === session) || null;
}
export function latestCheckpoint(root, sessionId = null) { return selectCheckpoint(readJournal(root), sessionId); }
export function saveCompaction(root, sessionId) {
    const rows = readJournal(root), checkpoint = selectCheckpoint(rows, sessionId);
    const record = { version: 1, time: new Date().toISOString(), session: sessionId == null ? null : sha256(sessionId), ...journalHead(rows), checkpoint: checkpoint ? { hash: checkpoint.hash, data: checkpoint.data } : null, conversationCaptured: false };
    const relative = `.steward/state/checkpoints/${randomUUID()}.json`;
    atomicWrite(root, relative, JSON.stringify(record, null, 2) + '\n');
    return { path: relative, ...journalHead(rows), hasCheckpoint: !!checkpoint };
}
