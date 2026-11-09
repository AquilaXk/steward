import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJSON, sha256, canonical, safePath, rootOf, compareAscii, toSessionHash } from './fs.mjs';
import { validateJournalRow, RECORD_TYPES } from './schema.mjs';
import { insist, StewardError } from './errors.mjs';

const DIRECTORY = '.steward/state/journal';
const JOURNAL_FILE_RE = /^\d{8}-[a-f0-9-]+\.json$/;
const ISO_PREFIX_RE = /^\d{4}-\d\d-\d\dT/;

/**
 * Global in-memory cache registry keyed by canonical project root path.
 * @type {Map<string, JournalCache>}
 */
const caches = new Map();

function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        if (Array.isArray(value)) {
            for (const item of value) deepFreeze(item);
        } else {
            for (const key of Object.keys(value)) deepFreeze(value[key]);
        }
    }
    return value;
}

/**
 * Creates an empty journal cache structure.
 */
function createEmptyCache() {
    return {
        files: [],
        rows: [],
        mtimes: new Map(),
        sizes: new Map(),
        inos: new Map(),
        ctimes: new Map(),
        index: {
            byHash: new Map(),
            metaByHash: new Map(),
            byType: new Map(),
            byRecordId: new Map(),
            bySession: new Map(),
            byTag: new Map(),
            supersededHashes: new Set()
        }
    };
}

function extractRowTags(row) {
    return Array.isArray(row.data?.tags) ? row.data.tags : [];
}

function indexRowSession(index, row) {
    if (row.type === 'checkpoint') {
        const sessionKey = row.data?.session ?? null;
        if (!index.bySession.has(sessionKey)) {
            index.bySession.set(sessionKey, []);
        }
        index.bySession.get(sessionKey).push(row);
    }
}

function indexRowTags(index, row, tags) {
    for (const tag of tags) {
        if (typeof tag === 'string') {
            if (!index.byTag.has(tag)) index.byTag.set(tag, []);
            index.byTag.get(tag).push(row);
        }
    }
}

/**
 * Indexes a single journal row into the in-memory index structures.
 */
function indexRow(index, row) {
    index.byHash.set(row.hash, row);

    const tags = extractRowTags(row);
    index.metaByHash.set(row.hash, {
        timeMs: Date.parse(row.time),
        expiresAtMs: row.type === 'knowledge' && row.data.expiresAt !== null ? Date.parse(row.data.expiresAt) : null,
        searchText: JSON.stringify(row.data).toLocaleLowerCase('en-US'),
        tagSet: new Set(tags)
    });

    if (!index.byType.has(row.type)) {
        index.byType.set(row.type, []);
    }
    index.byType.get(row.type).push(row);

    // Index by record ID (preserve all revisions for history queries)
    if (row.data?.id) {
        if (!index.byRecordId.has(row.data.id)) {
            index.byRecordId.set(row.data.id, []);
        }
        index.byRecordId.get(row.data.id).push(row);
    }

    indexRowSession(index, row);
    indexRowTags(index, row, tags);

    if (row.data?.supersedes) {
        index.supersededHashes.add(row.data.supersedes);
    }
}

function validateJournalFilename(name) {
    if (typeof name !== 'string' || path.basename(name) !== name || !JOURNAL_FILE_RE.test(name)) {
        throw new StewardError('BAD_PATH', 'Invalid journal filename');
    }
}

/**
 * Lists candidate journal files from disk, ignoring OS metadata and temp files.
 */
function listJournalFiles(root) {
    const resolvedDir = safePath(root, DIRECTORY);
    try {
        const names = fs.readdirSync(resolvedDir) //NOSONAR
            .filter(n => !n.startsWith('.') && n !== 'Thumbs.db' && n !== 'desktop.ini')
            .sort(compareAscii);
        return { resolvedDir, names };
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return null;
    }
}

function isFileStatFresh(cache, name, stat) {
    return (
        stat.mtimeMs === cache.mtimes.get(name) &&
        stat.size === cache.sizes.get(name) &&
        stat.ino === cache.inos.get(name) &&
        stat.ctimeMs === cache.ctimes.get(name)
    );
}

/**
 * Checks whether the existing in-memory cache is still fresh and matches disk state.
 */
function isCacheUpToDate(resolvedDir, cache, names) {
    if (!cache || cache.files.length > names.length) {
        return false;
    }
    for (let i = 0; i < cache.files.length; i++) {
        const name = names[i];
        if (cache.files[i] !== name) {
            return false;
        }
        try {
            validateJournalFilename(name);
            const filePath = path.join(resolvedDir, name);
            const stat = fs.lstatSync(filePath); //NOSONAR
            if (stat.isSymbolicLink() || !isFileStatFresh(cache, name, stat)) {
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
function loadJournalRow(root, resolvedDir, name, expectedSeq, previousHash) {
    validateJournalFilename(name);
    const filePath = path.join(resolvedDir, name);
    const stat = fs.lstatSync(filePath); //NOSONAR
    insist(!stat.isSymbolicLink(), 'SYMLINK', `Refusing symbolic link: ${path.relative(root, filePath)}`);
    const row = readJSON(filePath, 4 * 1024 * 1024);
    try {
        validateJournalRow(row);
    } catch {
        insist(false, 'JOURNAL_CORRUPT', `Invalid journal record at sequence ${expectedSeq}.`);
    }
    const { hash, ...payload } = row;
    insist(row.seq === expectedSeq && row.previous === previousHash && hash === sha256(canonical(payload)), 'JOURNAL_CORRUPT', `Journal integrity check failed at record ${expectedSeq}.`);
    insist(name === `${String(row.seq).padStart(8, '0')}-${row.id}.json`, 'JOURNAL_CORRUPT', 'Journal filename identity mismatch.');
    return { row: deepFreeze(row), mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

/**
 * Synchronizes the in-memory journal cache for a given project root.
 * Detects incremental additions or invalidations.
 *
 * @param {string} root - Project root directory.
 * @returns {{ rows: object[], cache: object }} Synced journal rows and index.
 */
export function syncJournalCache(root) {
    root = rootOf(root);
    const listed = listJournalFiles(root);
    if (listed === null) {
        caches.delete(root);
        return { rows: [], cache: createEmptyCache() };
    }
    const { resolvedDir, names } = listed;

    let cache = caches.get(root);
    if (!isCacheUpToDate(resolvedDir, cache, names)) {
        cache = createEmptyCache();
        caches.set(root, cache);
    }

    const startIndex = cache.rows.length;
    let previous = startIndex === 0 ? null : cache.rows[startIndex - 1].hash;

    for (let i = startIndex; i < names.length; i++) {
        const name = names[i];
        const { row, mtimeMs, size, ino, ctimeMs } = loadJournalRow(root, resolvedDir, name, cache.rows.length + 1, previous);
        cache.files.push(name);
        cache.rows.push(row);
        cache.mtimes.set(name, mtimeMs);
        cache.sizes.set(name, size);
        cache.inos.set(name, ino);
        cache.ctimes.set(name, ctimeMs);
        indexRow(cache.index, row);
        previous = row.hash;
    }

    return { rows: cache.rows.slice(), cache };
}

/**
 * Invalidates the in-memory cache for a project root.
 * @param {string} root - Project root directory.
 */
export function invalidateJournalCache(root) {
    try {
        caches.delete(rootOf(root));
    } catch {
        caches.delete(path.resolve(root));
    }
}

function parseTimestampBound(value, label) {
    if (value === undefined) return undefined;
    if (typeof value === 'number') {
        insist(Number.isFinite(value), 'BAD_QUERY', `Invalid ${label} timestamp.`);
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        insist(value.length <= 80 && ISO_PREFIX_RE.test(value) && Number.isFinite(parsed), 'BAD_QUERY', `Invalid ${label} timestamp.`);
        return parsed;
    }
    insist(false, 'BAD_QUERY', `Invalid ${label} timestamp.`);
}

/**
 * Intersects active indexed filter buckets starting from the smallest bucket.
 * Returns [] immediately if any specified indexed filter has 0 matches.
 */
function selectSmallestCandidateSet(rows, index, { type, tag, session, recordId }) {
    const lookups = [
        [type, index.byType],
        [tag, index.byTag],
        [session, index.bySession],
        [recordId, index.byRecordId]
    ];
    const activeBuckets = [];
    for (const [key, map] of lookups) {
        if (key === undefined) continue;
        const bucket = map.get(key);
        if (!bucket || bucket.length === 0) return [];
        activeBuckets.push(bucket);
    }
    if (activeBuckets.length === 0) return rows;
    if (activeBuckets.length === 1) return activeBuckets[0];

    activeBuckets.sort((a, b) => a.length - b.length);
    const smallest = activeBuckets[0];
    const otherSets = activeBuckets.slice(1).map(b => new Set(b));
    return smallest.filter(row => otherSets.every(s => s.has(row)));
}

/**
 * Evaluates whether a journal row and its precomputed metadata match all query filter criteria.
 */
function matchesQueryFilter(row, meta, { type, recordId, session, needle, sinceMs, untilMs, tag }) {
    if (type !== undefined && row.type !== type) return false;
    if (recordId !== undefined && row.data?.id !== recordId) return false;
    if (session !== undefined && (row.type !== 'checkpoint' || (row.data?.session ?? null) !== session)) return false;
    if (tag !== undefined && !meta.tagSet.has(tag)) return false;
    if (sinceMs !== undefined && meta.timeMs < sinceMs) return false;
    if (untilMs !== undefined && meta.timeMs > untilMs) return false;
    if (needle && !meta.searchText.includes(needle)) return false;
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
    root = rootOf(root);
    insist(type === undefined || [...RECORD_TYPES, 'verification'].includes(type), 'BAD_QUERY', 'Unknown record type.');
    insist(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'BAD_QUERY', 'limit must be an integer from 1 to 100.');
    insist(typeof text === 'string' && text.length <= 256, 'BAD_QUERY', 'Query text exceeds 256 characters.');
    insist(Number.isFinite(now), 'BAD_QUERY', 'Invalid query time.');
    insist(sessionId === undefined || (typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256), 'BAD_QUERY', 'Invalid session ID.');
    insist(tag === undefined || (typeof tag === 'string' && tag.trim() && tag.length <= 128), 'BAD_QUERY', 'Invalid tag filter.');

    const sinceMs = parseTimestampBound(since, 'since');
    const untilMs = parseTimestampBound(until, 'until');

    const { rows, cache } = syncJournalCache(root);
    const session = sessionId === undefined ? undefined : toSessionHash(sessionId);
    const needle = text ? text.toLocaleLowerCase('en-US') : '';

    const candidates = selectSmallestCandidateSet(rows, cache.index, { type, tag, session, recordId });
    const filterContext = { type, recordId, session, needle, sinceMs, untilMs, tag };
    const { supersededHashes, metaByHash } = cache.index;

    const matchedRows = [];
    let total = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
        const row = candidates[i];
        const meta = metaByHash.get(row.hash);
        const superseded = supersededHashes.has(row.hash);
        const expired = meta.expiresAtMs !== null && meta.expiresAtMs <= now;
        if (!history && (superseded || expired)) continue;
        if (!matchesQueryFilter(row, meta, filterContext)) continue;
        total++;
        if (matchedRows.length < limit) {
            matchedRows.push(Object.freeze({ ...row, superseded, expired }));
        }
    }

    const head = { count: rows.length, head: rows.at(-1)?.hash || null };
    return {
        ...head,
        total,
        limit,
        truncated: total > limit,
        history,
        rows: matchedRows
    };
}


