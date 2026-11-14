// SPDX-License-Identifier: Apache-2.0
// Word-packed Uint32Array bitset intersection (8-way unrolled) and reverse clz32 bit scanning
// adapted from lemire/FastBitSet.js (Apache-2.0). See THIRD_PARTY_NOTICES.md for details.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJSON, sha256, canonical, safePath, rootOf, compareAscii, toSessionHash } from './fs.mjs';
import { validateJournalRow, RECORD_TYPES } from './schema.mjs';
import { insist, StewardError } from './errors.mjs';

const DIRECTORY = '.steward/state/journal';
const JOURNAL_FILE_RE = /^\d{8}-[a-f0-9-]+\.json$/;
const ISO_PREFIX_RE = /^\d{4}-\d\d-\d\dT/;
const INITIAL_BITSET_WORDS = 8;
const INITIAL_ROW_CAPACITY = 256;

/**
 * Global in-memory cache registry keyed by canonical project root path.
 * @type {Map<string, object>}
 */
const caches = new Map();
let intersectScratch = new Uint32Array(64);

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

function clonePlain(value) {
    return value === null || typeof value !== 'object' ? value : structuredClone(value);
}

function collectSearchableValues(value, out) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
        if (value.length > 0) out.push(value);
        return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        out.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            collectSearchableValues(value[i], out);
        }
        return;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            collectSearchableValues(value[keys[i]], out);
        }
    }
}

function buildSearchText(data) {
    const parts = [];
    collectSearchableValues(data, parts);
    return parts.join(' ').toLowerCase();
}

function ensureBitCapacity(bits, wordIndex) {
    if (wordIndex < bits.length) return bits;
    let newLen = Math.max(INITIAL_BITSET_WORDS, bits.length * 2);
    while (newLen <= wordIndex) newLen *= 2;
    const next = new Uint32Array(newLen);
    next.set(bits);
    return next;
}

function setBitInMap(map, key, rowIdx) {
    const wordIdx = rowIdx >>> 5;
    let bits = map.get(key);
    if (bits === undefined) {
        bits = new Uint32Array(Math.max(INITIAL_BITSET_WORDS, wordIdx + 1));
    } else if (wordIdx >= bits.length) {
        bits = ensureBitCapacity(bits, wordIdx);
    }
    bits[wordIdx] |= (1 << (rowIdx & 31));
    map.set(key, bits);
}

function ensureFloat64Capacity(arr, targetIdx) {
    if (targetIdx < arr.length) return arr;
    let newLen = arr.length * 2;
    while (newLen <= targetIdx) newLen *= 2;
    const next = new Float64Array(newLen);
    next.set(arr);
    return next;
}

/**
 * Creates an empty journal cache structure with object indices and aligned Uint32Array bitsets.
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
            rowIndexByHash: new Map(),
            metaByHash: new Map(),
            byType: new Map(),
            byRecordId: new Map(),
            bySession: new Map(),
            byTag: new Map(),
            byTypeBits: new Map(),
            byRecordIdBits: new Map(),
            bySessionBits: new Map(),
            byTagBits: new Map(),
            supersededHashes: new Set(),
            supersededBits: new Uint32Array(INITIAL_BITSET_WORDS),
            timeMsArr: new Float64Array(INITIAL_ROW_CAPACITY),
            expiresAtMsArr: new Float64Array(INITIAL_ROW_CAPACITY),
            searchTextArr: []
        }
    };
}

function extractRowTags(row) {
    return Array.isArray(row.data?.tags) ? row.data.tags : [];
}

function indexRow(index, row, rowIdx) {
    index.byHash.set(row.hash, row);
    index.rowIndexByHash.set(row.hash, rowIdx);

    const timeMs = Date.parse(row.time);
    const expiresAtMs = row.type === 'knowledge' && row.data.expiresAt !== null
        ? Date.parse(row.data.expiresAt)
        : null;
    const searchText = buildSearchText(row.data);
    const tags = extractRowTags(row);

    index.metaByHash.set(row.hash, {
        timeMs,
        expiresAtMs,
        searchText,
        tagSet: new Set(tags)
    });

    index.timeMsArr = ensureFloat64Capacity(index.timeMsArr, rowIdx);
    index.expiresAtMsArr = ensureFloat64Capacity(index.expiresAtMsArr, rowIdx);
    index.timeMsArr[rowIdx] = timeMs;
    index.expiresAtMsArr[rowIdx] = expiresAtMs === null ? Number.NaN : expiresAtMs;
    index.searchTextArr[rowIdx] = searchText;

    let typeBucket = index.byType.get(row.type);
    if (typeBucket === undefined) {
        typeBucket = [];
        index.byType.set(row.type, typeBucket);
    }
    typeBucket.push(row);
    setBitInMap(index.byTypeBits, row.type, rowIdx);

    // Index by record ID (preserve all revisions for history queries)
    if (row.data?.id) {
        let recBucket = index.byRecordId.get(row.data.id);
        if (recBucket === undefined) {
            recBucket = [];
            index.byRecordId.set(row.data.id, recBucket);
        }
        recBucket.push(row);
        setBitInMap(index.byRecordIdBits, row.data.id, rowIdx);
    }

    if (row.type === 'checkpoint') {
        const sessKey = row.data?.session ?? null;
        let sessBucket = index.bySession.get(sessKey);
        if (sessBucket === undefined) {
            sessBucket = [];
            index.bySession.set(sessKey, sessBucket);
        }
        sessBucket.push(row);
        setBitInMap(index.bySessionBits, sessKey, rowIdx);
    }

    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        let tagBucket = index.byTag.get(tag);
        if (tagBucket === undefined) {
            tagBucket = [];
            index.byTag.set(tag, tagBucket);
        }
        tagBucket.push(row);
        setBitInMap(index.byTagBits, tag, rowIdx);
    }

    if (row.data?.supersedes) {
        const prevHash = row.data.supersedes;
        index.supersededHashes.add(prevHash);
        const prevIdx = index.rowIndexByHash.get(prevHash);
        if (prevIdx !== undefined) {
            const wordIdx = prevIdx >>> 5;
            index.supersededBits = ensureBitCapacity(index.supersededBits, wordIdx);
            index.supersededBits[wordIdx] |= (1 << (prevIdx & 31));
        }
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
 * Retains per-file lstatSync checks so out-of-band in-place file edits are always caught.
 */
function isCacheUpToDate(resolvedDir, cache, names) {
    if (!cache || cache.files.length > names.length) {
        return false;
    }
    const prefix = resolvedDir + path.sep;
    for (let i = 0; i < cache.files.length; i++) {
        const name = names[i];
        if (cache.files[i] !== name) {
            return false;
        }
        try {
            const stat = fs.lstatSync(prefix + name); //NOSONAR
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

function appendToCacheState(cache, name, row, stat) {
    const rowIdx = cache.rows.length;
    cache.files.push(name);
    cache.rows.push(row);
    cache.mtimes.set(name, stat.mtimeMs);
    cache.sizes.set(name, stat.size);
    cache.inos.set(name, stat.ino);
    cache.ctimes.set(name, stat.ctimeMs);
    indexRow(cache.index, row, rowIdx);
}

function syncJournalCacheInternal(root, fresh) {
    root = rootOf(root);
    if (fresh) {
        caches.delete(root);
    }
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
        const loaded = loadJournalRow(root, resolvedDir, name, cache.rows.length + 1, previous);
        appendToCacheState(cache, name, loaded.row, loaded);
        previous = loaded.row.hash;
    }

    return { rows: cache.rows, cache };
}

/**
 * Synchronizes the in-memory journal cache for a given project root.
 * Detects incremental additions or invalidations.
 *
 * @param {string} root - Project root directory.
 * @param {object} [options] - Sync options.
 * @param {boolean} [options.fresh=false] - Force cache invalidation before reading.
 * @returns {{ rows: object[], cache: object }} Synced journal rows and index.
 */
export function syncJournalCache(root, { fresh = false } = {}) {
    const { rows, cache } = syncJournalCacheInternal(root, fresh);
    return { rows: rows.slice(), cache };
}

/**
 * Internal write-through helper called by journal appendInternal after atomicWrite.
 * Registers the newly appended record in the already-synced cache without re-reading JSON or re-hashing.
 */
export function recordAppendedJournalRow(root, fileName, row) {
    const resolvedRoot = rootOf(root);
    const cache = caches.get(resolvedRoot);
    if (!cache || cache.rows.length !== row.seq - 1) return;
    try {
        const stat = fs.lstatSync(path.join(resolvedRoot, DIRECTORY, fileName)); //NOSONAR
        if (stat.isSymbolicLink()) {
            caches.delete(resolvedRoot);
            return;
        }
        const frozen = deepFreeze({ ...row, data: clonePlain(row.data) });
        appendToCacheState(cache, fileName, frozen, stat);
    } catch {
        caches.delete(resolvedRoot);
    }
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

function collectActiveBitsets(index, { type, tag, session, recordId }) {
    const bitsets = [];
    if (type !== undefined) {
        const bs = index.byTypeBits.get(type);
        if (bs === undefined) return null;
        bitsets.push(bs);
    }
    if (tag !== undefined) {
        const bs = index.byTagBits.get(tag);
        if (bs === undefined) return null;
        bitsets.push(bs);
    }
    if (session !== undefined) {
        const bs = index.bySessionBits.get(session);
        if (bs === undefined) return null;
        bitsets.push(bs);
    }
    if (recordId !== undefined) {
        const bs = index.byRecordIdBits.get(recordId);
        if (bs === undefined) return null;
        bitsets.push(bs);
    }
    return bitsets;
}

function computeBitsetIntersectionScratch(bitsets, wordCount) {
    if (intersectScratch.length < wordCount) {
        intersectScratch = new Uint32Array(Math.max(wordCount, intersectScratch.length * 2));
    }
    const dst = intersectScratch;
    const b0 = bitsets[0];
    const b1 = bitsets[1];
    let i = 0;

    // 8-way unrolled bitwise AND across the first two filter bitsets (FastBitSet pattern)
    const unrollEnd = wordCount - (wordCount & 7);
    for (; i < unrollEnd; i += 8) {
        dst[i]     = b0[i]     & b1[i];
        dst[i + 1] = b0[i + 1] & b1[i + 1];
        dst[i + 2] = b0[i + 2] & b1[i + 2];
        dst[i + 3] = b0[i + 3] & b1[i + 3];
        dst[i + 4] = b0[i + 4] & b1[i + 4];
        dst[i + 5] = b0[i + 5] & b1[i + 5];
        dst[i + 6] = b0[i + 6] & b1[i + 6];
        dst[i + 7] = b0[i + 7] & b1[i + 7];
    }
    for (; i < wordCount; i++) {
        dst[i] = b0[i] & b1[i];
    }

    for (let k = 2; k < bitsets.length; k++) {
        const bk = bitsets[k];
        let j = 0;
        for (; j < unrollEnd; j += 8) {
            dst[j]     &= bk[j];
            dst[j + 1] &= bk[j + 1];
            dst[j + 2] &= bk[j + 2];
            dst[j + 3] &= bk[j + 3];
            dst[j + 4] &= bk[j + 4];
            dst[j + 5] &= bk[j + 5];
            dst[j + 6] &= bk[j + 6];
            dst[j + 7] &= bk[j + 7];
        }
        for (; j < wordCount; j++) {
            dst[j] &= bk[j];
        }
    }
    return dst;
}

/**
 * Queries the journal using bitset metadata indexing (Uint32Array word intersections + clz32 reverse scan).
 * Supports filtering by type, tag, timestamp bounds (since/until), session, and value-only text search.
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

    const { rows, cache } = syncJournalCacheInternal(root, false);
    const rowsLen = rows.length;
    const head = { count: rowsLen, head: rowsLen > 0 ? rows[rowsLen - 1].hash : null };
    if (rowsLen === 0) {
        return { ...head, total: 0, limit, truncated: false, history, rows: [] };
    }

    const session = sessionId === undefined ? undefined : toSessionHash(sessionId);
    const needle = text ? text.toLowerCase() : '';
    const idx = cache.index;
    const bitsets = collectActiveBitsets(idx, { type, tag, session, recordId });

    if (bitsets === null) {
        return { ...head, total: 0, limit, truncated: false, history, rows: [] };
    }

    const { supersededBits, timeMsArr, expiresAtMsArr, searchTextArr } = idx;
    const matchedRows = [];
    let total = 0;

    if (bitsets.length === 0) {
        for (let i = rowsLen - 1; i >= 0; i--) {
            const superseded = ((supersededBits[i >>> 5] >>> (i & 31)) & 1) === 1;
            const expired = expiresAtMsArr[i] <= now;
            if (!history && (superseded || expired)) continue;
            if (sinceMs !== undefined && timeMsArr[i] < sinceMs) continue;
            if (untilMs !== undefined && timeMsArr[i] > untilMs) continue;
            if (needle && !searchTextArr[i].includes(needle)) continue;
            total++;
            if (matchedRows.length < limit) {
                matchedRows.push(Object.freeze({ ...rows[i], superseded, expired }));
            }
        }
    } else {
        const maxWords = ((rowsLen - 1) >>> 5) + 1;
        let wordCount = maxWords;
        for (let k = 0; k < bitsets.length; k++) {
            if (bitsets[k].length < wordCount) wordCount = bitsets[k].length;
        }
        const scanWords = bitsets.length === 1
            ? bitsets[0]
            : computeBitsetIntersectionScratch(bitsets, wordCount);

        for (let wIdx = wordCount - 1; wIdx >= 0; wIdx--) {
            let w = scanWords[wIdx];
            if (w === 0) continue;
            const base = wIdx << 5;
            const supWord = supersededBits[wIdx] || 0;
            while (w !== 0) {
                const bit = 31 - Math.clz32(w);
                w ^= (1 << bit);
                const rowIdx = base + bit;
                if (rowIdx >= rowsLen) continue;
                const superseded = ((supWord >>> bit) & 1) === 1;
                const expired = expiresAtMsArr[rowIdx] <= now;
                if (!history && (superseded || expired)) continue;
                if (sinceMs !== undefined && timeMsArr[rowIdx] < sinceMs) continue;
                if (untilMs !== undefined && timeMsArr[rowIdx] > untilMs) continue;
                if (needle && !searchTextArr[rowIdx].includes(needle)) continue;
                total++;
                if (matchedRows.length < limit) {
                    matchedRows.push(Object.freeze({ ...rows[rowIdx], superseded, expired }));
                }
            }
        }
    }

    return {
        ...head,
        total,
        limit,
        truncated: total > limit,
        history,
        rows: matchedRows
    };
}
