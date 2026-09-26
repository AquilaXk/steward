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
 * Creates an empty journal cache structure.
 */
function createEmptyCache() {
    return {
        files: [],
        rows: [],
        mtimes: new Map(),
        sizes: new Map(),
        index: {
            byType: new Map(),
            byRecordId: new Map(),
            bySession: new Map(),
            byTag: new Map(),
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

    // Index by tags if present
    if (row.data) {
        const tags = Array.isArray(row.data.tags) ? row.data.tags : (row.data.tag ? [row.data.tag] : []);
        for (const tag of tags) {
            if (typeof tag === 'string') {
                if (!index.byTag.has(tag)) index.byTag.set(tag, []);
                index.byTag.get(tag).push(row);
            }
        }
    }

    // Index superseded hashes
    if (row.data && row.data.supersedes) {
        index.supersededHashes.add(row.data.supersedes);
    }
}

/**
 * Safely resolves a validated journal filename relative to project root.
 * Guarantees the filename matches the strict journal format and prevents path traversal.
 */
function getRecordPath(root, name) {
    insist(typeof name === 'string' && /^\d{8}-[a-f0-9-]+\.json$/.test(name), 'JOURNAL_CORRUPT', 'Unexpected file in journal.');
    return safePath(root, `${DIRECTORY}/${name}`);
}

/**
 * Lists candidate journal files from disk, ignoring OS metadata and temp files.
 */
function listJournalFiles(root) {
    const dir = safePath(root, DIRECTORY);
    try {
        const names = fs.readdirSync(dir).filter(n => !n.startsWith('.tmp-')).sort();
        return names.filter(n => !n.startsWith('.') && n !== 'Thumbs.db' && n !== 'desktop.ini');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return null;
    }
}

/**
 * Checks whether the existing in-memory cache is still fresh and matches disk state.
 */
function isCacheUpToDate(root, cache, names) {
    if (!cache || cache.files.length > names.length) {
        return false;
    }
    for (let i = 0; i < cache.files.length; i++) {
        const name = names[i];
        if (cache.files[i] !== name) {
            return false;
        }
        try {
            const filePath = getRecordPath(root, name);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs !== cache.mtimes.get(name) || stat.size !== cache.sizes.get(name)) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Reads, verifies cryptographic integrity, and validates a single journal record from disk.
 */
function loadJournalRow(root, name, expectedSeq, previousHash) {
    const filePath = getRecordPath(root, name);
    const stat = fs.statSync(filePath);
    const row = readJSON(filePath, 4 * 1024 * 1024);
    try {
        validateJournalRow(row);
    } catch {
        insist(false, 'JOURNAL_CORRUPT', `Invalid journal record at sequence ${expectedSeq}.`);
    }
    const { hash, ...payload } = row;
    insist(row.seq === expectedSeq && row.previous === previousHash && hash === sha256(canonical(payload)), 'JOURNAL_CORRUPT', `Journal integrity check failed at record ${expectedSeq}.`);
    insist(name === `${String(row.seq).padStart(8, '0')}-${row.id}.json`, 'JOURNAL_CORRUPT', 'Journal filename identity mismatch.');
    return { row, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * Synchronizes the in-memory journal cache for a given project root.
 * Detects incremental additions or invalidations.
 *
 * @param {string} root - Project root directory.
 * @returns {{ rows: object[], cache: object }} Synced journal rows and index.
 */
export function syncJournalCache(root) {
    const names = listJournalFiles(root);
    if (names === null) {
        caches.delete(root);
        return { rows: [], cache: createEmptyCache() };
    }

    let cache = caches.get(root);
    if (!isCacheUpToDate(root, cache, names)) {
        cache = createEmptyCache();
        caches.set(root, cache);
    }

    const startIndex = cache.rows.length;
    let previous = startIndex === 0 ? null : cache.rows[startIndex - 1].hash;

    for (let i = startIndex; i < names.length; i++) {
        const name = names[i];
        const { row, mtimeMs, size } = loadJournalRow(root, name, cache.rows.length + 1, previous);
        cache.files.push(name);
        cache.rows.push(row);
        cache.mtimes.set(name, mtimeMs);
        cache.sizes.set(name, size);
        indexRow(cache.index, row);
        previous = row.hash;
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
 * Evaluates whether a journal row matches all specified query filter criteria.
 */
function matchesQueryFilter(row, { type, recordId, session, needle, sinceMs, untilMs, tag }) {
    if (type !== undefined && row.type !== type) return false;
    if (recordId !== undefined && row.data?.id !== recordId) return false;
    if (session !== undefined && (row.type !== 'checkpoint' || row.data?.session !== session)) return false;
    if (needle && !JSON.stringify(row.data).toLocaleLowerCase('en-US').includes(needle)) return false;
    if (sinceMs !== undefined && Date.parse(row.time) < sinceMs) return false;
    if (untilMs !== undefined && Date.parse(row.time) > untilMs) return false;
    if (tag !== undefined) {
        const tags = Array.isArray(row.data?.tags) ? row.data.tags : (row.data?.tag ? [row.data.tag] : []);
        if (!tags.includes(tag)) return false;
    }
    return true;
}

/**
 * Queries the journal using in-memory metadata indexing for fast filtering.
 * Supports filtering by type, tag, timestamp bounds (since/until), session, and text.
 *
 * @param {string} root - Project root.
 * @param {object} options - Query options.
 * @returns {object} Query results matching schema.
 */
export function queryJournalIndexed(root, { type, text = '', limit = 20, history = false, recordId, sessionId, tag, since, until, now = Date.now() } = {}) {
    insist(type === undefined || [...RECORD_TYPES, 'verification'].includes(type), 'BAD_QUERY', 'Unknown record type.');
    insist(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'BAD_QUERY', 'limit must be an integer from 1 to 100.');
    insist(typeof text === 'string' && text.length <= 256, 'BAD_QUERY', 'Query text exceeds 256 characters.');
    insist(Number.isFinite(now), 'BAD_QUERY', 'Invalid query time.');
    insist(sessionId === undefined || (typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256), 'BAD_QUERY', 'Invalid session ID.');

    const { rows, cache } = syncJournalCache(root);
    const session = sessionId === undefined ? undefined : sha256(sessionId);
    const needle = text.toLocaleLowerCase('en-US');
    const sinceMs = since === undefined ? undefined : (typeof since === 'number' ? since : Date.parse(since));
    const untilMs = until === undefined ? undefined : (typeof until === 'number' ? until : Date.parse(until));

    // Narrow candidate pool using in-memory indices when possible
    let candidates = rows;
    if (type !== undefined) {
        candidates = cache.index.byType.get(type) || [];
    } else if (tag !== undefined && cache.index.byTag.has(tag)) {
        candidates = cache.index.byTag.get(tag) || [];
    } else if (sessionId !== undefined && cache.index.bySession.has(session)) {
        candidates = cache.index.bySession.get(session) || [];
    }

    const filterContext = { type, recordId, session, needle, sinceMs, untilMs, tag };

    const matches = candidates.map(row => ({
        ...row,
        superseded: cache.index.supersededHashes.has(row.hash),
        expired: row.type === 'knowledge' && row.data.expiresAt !== null && Date.parse(row.data.expiresAt) <= now
    })).filter(row =>
        (history || (!row.superseded && !row.expired)) &&
        matchesQueryFilter(row, filterContext)
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
