import * as fs from 'node:fs';
import { safePath, readJSON, sha256, canonical } from './fs.mjs';
import { validateJournalRow, RECORD_TYPES } from './schema.mjs';
import { insist } from './errors.mjs';

const DIRECTORY = '.steward/state/journal';

/**
 * Global in-memory cache registry keyed by project root path.
 * @type {Map<string, JournalCache>}
 */
const caches = new Map();

/**
 * Extracts searchable lowercase tokens from an object for in-memory text indexing.
 * @param {object} obj
 * @returns {string[]}
 */
function extractTokens(obj) {
    if (!obj) return [];
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []);
}

/**
 * Creates an empty journal cache structure.
 */
function createEmptyCache() {
    return {
        files: [],
        rows: [],
        mtimes: new Map(),
        index: {
            byType: new Map(),
            byRecordId: new Map(),
            bySession: new Map(),
            supersededHashes: new Set()
        }
    };
}

/**
 * Indexes a single journal row into the in-memory index structures.
 */
function indexRow(index, row) {
    // Index by type
    if (!index.byType.has(row.type)) {
        index.byType.set(row.type, []);
    }
    index.byType.get(row.type).push(row);

    // Index by record ID
    if (row.data && row.data.id) {
        index.byRecordId.set(row.data.id, row);
    }

    // Index by checkpoint session
    if (row.type === 'checkpoint' && row.data && row.data.session) {
        if (!index.bySession.has(row.data.session)) {
            index.bySession.set(row.data.session, []);
        }
        index.bySession.get(row.data.session).push(row);
    }

    // Index superseded hashes
    if (row.data && row.data.supersedes) {
        index.supersededHashes.add(row.data.supersedes);
    }
}

/**
 * Synchronizes the in-memory journal cache for a given project root.
 * Detects incremental additions or invalidations.
 *
 * @param {string} root - Project root directory.
 * @returns {{ rows: object[], cache: object }} Synced journal rows and index.
 */
export function syncJournalCache(root) {
    const dir = safePath(root, DIRECTORY);
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(n => !n.startsWith('.tmp-')).sort();
        names = names.filter(n => !n.startsWith('.') && n !== 'Thumbs.db' && n !== 'desktop.ini');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        caches.delete(root);
        return { rows: [], cache: createEmptyCache() };
    }

    let cache = caches.get(root);

    // Verify validity of existing cache
    let canIncrement = false;
    if (cache && cache.files.length <= names.length) {
        let match = true;
        for (let i = 0; i < cache.files.length; i++) {
            if (cache.files[i] !== names[i]) {
                match = false;
                break;
            }
            try {
                const stat = fs.statSync(safePath(root, `${DIRECTORY}/${names[i]}`));
                if (stat.mtimeMs !== cache.mtimes.get(names[i])) {
                    match = false;
                    break;
                }
            } catch {
                match = false;
                break;
            }
        }
        canIncrement = match;
    }

    if (!canIncrement) {
        // Rebuild from scratch
        cache = createEmptyCache();
        caches.set(root, cache);
    }

    const startIndex = cache.rows.length;
    let previous = startIndex === 0 ? null : cache.rows[startIndex - 1].hash;

    for (let i = startIndex; i < names.length; i++) {
        const name = names[i];
        insist(/^\d{8}-[a-f0-9-]+\.json$/.test(name), 'JOURNAL_CORRUPT', 'Unexpected file in journal.');
        const filePath = safePath(root, `${DIRECTORY}/${name}`);
        const stat = fs.statSync(filePath);
        const row = readJSON(filePath, 4 * 1024 * 1024);
        try {
            validateJournalRow(row);
        } catch {
            insist(false, 'JOURNAL_CORRUPT', `Invalid journal record at sequence ${cache.rows.length + 1}.`);
        }
        const { hash, ...payload } = row;
        insist(row.seq === cache.rows.length + 1 && row.previous === previous && hash === sha256(canonical(payload)), 'JOURNAL_CORRUPT', `Journal integrity check failed at record ${cache.rows.length + 1}.`);
        insist(name === `${String(row.seq).padStart(8, '0')}-${row.id}.json`, 'JOURNAL_CORRUPT', 'Journal filename identity mismatch.');

        cache.files.push(name);
        cache.rows.push(row);
        cache.mtimes.set(name, stat.mtimeMs);
        indexRow(cache.index, row);
        previous = hash;
    }

    return { rows: cache.rows, cache };
}

/**
 * Invalidates the in-memory cache for a project root.
 * @param {string} root - Project root directory.
 */
export function invalidateJournalCache(root) {
    caches.delete(root);
}

/**
 * Queries the journal using in-memory metadata indexing for fast filtering.
 *
 * @param {string} root - Project root.
 * @param {object} options - Query options.
 * @returns {object} Query results matching schema.
 */
export function queryJournalIndexed(root, { type, text = '', limit = 20, history = false, recordId, sessionId, now = Date.now() } = {}) {
    insist(type === undefined || [...RECORD_TYPES, 'verification'].includes(type), 'BAD_QUERY', 'Unknown record type.');
    insist(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'BAD_QUERY', 'limit must be an integer from 1 to 100.');
    insist(typeof text === 'string' && text.length <= 256, 'BAD_QUERY', 'Query text exceeds 256 characters.');
    insist(Number.isFinite(now), 'BAD_QUERY', 'Invalid query time.');
    insist(sessionId === undefined || (typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256), 'BAD_QUERY', 'Invalid session ID.');

    const { rows, cache } = syncJournalCache(root);
    const session = sessionId === undefined ? undefined : sha256(sessionId);
    const needle = text.toLocaleLowerCase('en-US');

    // Narrow candidate pool using in-memory indices when possible
    let candidates = rows;
    if (type !== undefined && cache.index.byType.has(type)) {
        candidates = cache.index.byType.get(type);
    }

    const matches = candidates.map(row => ({
        ...row,
        superseded: cache.index.supersededHashes.has(row.hash),
        expired: row.type === 'knowledge' && row.data.expiresAt !== null && Date.parse(row.data.expiresAt) <= now
    })).filter(row =>
        (history || (!row.superseded && !row.expired)) &&
        (type === undefined || row.type === type) &&
        (recordId === undefined || row.data.id === recordId) &&
        (session === undefined || (row.type === 'checkpoint' && row.data.session === session)) &&
        (!needle || JSON.stringify(row.data).toLocaleLowerCase('en-US').includes(needle))
    ).reverse();

    const head = { count: rows.length, head: rows.at(-1)?.hash || null };
    return {
        ...head,
        total: matches.length,
        limit,
        truncated: matches.length > limit,
        history,
        rows: matches.slice(0, limit)
    };
}
