// SPDX-License-Identifier: Apache-2.0
// Adapted from mvdan/sh (BSD-3-Clause) and golang/go path/filepath/match.go (BSD-3-Clause).
// See THIRD_PARTY_NOTICES.md for full upstream copyright and license texts.

import { StewardError } from './errors.mjs';

const ASCII_LIMIT = 128;
const ASCII_CASE_BIT = 0x20;
const ASCII_ALPHA_WORD_MASK = 0x07fffffe; // Bits 1..26 ('A'..'Z' in word 2, 'a'..'z' in word 3)

const OP_STAR = 1;
const OP_ANY = 2;
const OP_CHAR = 3;
const OP_ASCII_CLASS = 4;
const OP_UNICODE_CLASS = 5;
const OP_SHIFT = 29;
const OP_PAYLOAD_MASK = 0x1fffffff;
const ASCII_POOL_OFFSET_MASK = 0x0fffffff;

const FLAG_WS = 1;
const FLAG_OP = 1 << 1;
const FLAG_DBL_ESC = 1 << 2;
const FLAG_UNQUOTED_SPECIAL = 1 << 3;
const UNQUOTED_STOP_MASK = FLAG_WS | FLAG_OP | FLAG_UNQUOTED_SPECIAL;

const QUOTE_NONE = 0;
const QUOTE_SINGLE = 1;
const QUOTE_DOUBLE = 2;
const QUOTE_ANSI_C = 3;

const MAX_BRACE_CANDIDATES = 1024;
const MAX_BRACE_BRANCHES = 256;
const MAX_BRACE_DEPTH = 4;
const MAX_BRACE_EXPANDED_CHARS = 524288;
const MAX_SUBST_DEPTH = 8;
const MAX_SUBST_COUNT = 64;
const DEFAULT_MAX_STEPS = 1000000;

const HEX_TABLE = (() => {
    const table = new Int8Array(ASCII_LIMIT).fill(-1);
    for (let i = 0x30; i <= 0x39; i++) table[i] = i - 0x30;
    for (let i = 0x41; i <= 0x46; i++) table[i] = i - 0x37;
    for (let i = 0x61; i <= 0x66; i++) table[i] = i - 0x57;
    return table;
})();

const IS_LOWER_HEX = (() => {
    const table = new Uint8Array(ASCII_LIMIT);
    for (let i = 0x30; i <= 0x39; i++) table[i] = 1;
    for (let i = 0x61; i <= 0x66; i++) table[i] = 1;
    return table;
})();

const IS_COMMAND_SEPARATOR = new Set([';', '&&', '||', '|', '|&', '&', ';;', ';&', ';;&', '(', ')']);

const CHAR_FLAGS = (() => {
    const table = new Uint8Array(ASCII_LIMIT);
    for (const code of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) {
        table[code] |= FLAG_WS;
    }
    for (const ch of ['|', '&', ';', '(', ')', '<', '>']) {
        table[ch.codePointAt(0)] |= FLAG_OP;
    }
    for (const ch of ['"', '\\', '$', '`', '\n']) {
        table[ch.codePointAt(0)] |= FLAG_DBL_ESC;
    }
    for (const ch of ['\\', "'", '"', '$']) {
        table[ch.codePointAt(0)] |= FLAG_UNQUOTED_SPECIAL;
    }
    return table;
})();

const ANSI_C_ESCAPES = Object.freeze(Object.assign(Object.create(null), {
    a: '\x07',
    b: '\x08',
    e: '\x1b',
    E: '\x1b',
    f: '\x0c',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\x0b',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?'
}));

/**
 * Compares two strings strictly by UTF-16 code unit ordering.
 */
export function compareAscii(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Returns true if the string contains at least one non-whitespace character without allocating.
 */
export function hasNonWhitespace(str) {
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if ((c > 0x20 && c < 0xa0) || c < 0x09 || (c > 0x0d && c < 0x20)) return true;
        if (c >= 0xa0) return /\S/.test(str);
    }
    return false;
}

/**
 * Checks whether a UTF-16 string fits within max UTF-8 bytes without allocating on short strings.
 */
export function utf8Within(str, max) {
    if (str.length * 3 <= max) return true;
    if (str.length > max) return false;
    return Buffer.byteLength(str) <= max;
}

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Removes trailing forward slashes without regex backtracking.
 */
export function trimTrailingSlashes(str) {
    let end = str.length;
    while (end > 0 && str.charCodeAt(end - 1) === 0x2f) {
        end--;
    }
    return end === str.length ? str : str.slice(0, end);
}

/**
 * Checks whether a string is a 64-character lowercase hexadecimal SHA-256 digest.
 */
export function isSha256Hex(str) {
    if (typeof str !== 'string' || str.length !== 64) return false;
    for (let i = 0; i < 64; i++) {
        const c = str.charCodeAt(i);
        if (c >= ASCII_LIMIT || IS_LOWER_HEX[c] === 0) return false;
    }
    return true;
}

function isThreeCharOperator(c0, c1, c2) {
    if ((c0 | c1 | c2) >= ASCII_LIMIT) return false;
    const packed = (c0 << 16) | (c1 << 8) | c2;
    return (
        packed === 0x263e3e || // &>>
        packed === 0x3c3c3c || // <<<
        packed === 0x3b3b26    // ;;&
    );
}

function isTwoCharOperator(c0, c1) {
    if ((c0 | c1) >= ASCII_LIMIT) return false;
    const packed = (c0 << 8) | c1;
    return (
        packed === 0x2626 || // &&
        packed === 0x7c7c || // ||
        packed === 0x3b3b || // ;;
        packed === 0x3c3c || // <<
        packed === 0x3e3e || // >>
        packed === 0x3c26 || // <&
        packed === 0x3e26 || // >&
        packed === 0x3c3e || // <>
        packed === 0x3e7c || // >|
        packed === 0x7c26 || // |&
        packed === 0x263e || // &>
        packed === 0x3b26    // ;&
    );
}

function foldNonAsciiCodePoint(cp) {
    const lower = String.fromCodePoint(cp).toLowerCase();
    const firstCp = lower.codePointAt(0);
    const firstUnits = firstCp > 0xffff ? 2 : 1;
    return lower.length === firstUnits ? firstCp : cp;
}

function normalizeCodePoint(cp, caseSensitive) {
    if (caseSensitive) return cp;
    if (cp >= 0x41 && cp <= 0x5a) return cp | ASCII_CASE_BIT;
    if (cp < ASCII_LIMIT) return cp;
    return foldNonAsciiCodePoint(cp);
}

let nonAsciiFoldTable = null;
const ASTRAL_FOLD_BLOCKS = [
    [0x10400, 0x10427],
    [0x104b0, 0x104d3],
    [0x10c80, 0x10cb2],
    [0x118a0, 0x118bf],
    [0x16e40, 0x16e5f],
    [0x1e900, 0x1e921]
];

function getNonAsciiFoldTable() {
    if (nonAsciiFoldTable !== null) return nonAsciiFoldTable;
    const sources = [];
    const targets = [];
    for (let cp = ASCII_LIMIT; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const folded = foldNonAsciiCodePoint(cp);
        if (folded !== cp) {
            sources.push(cp);
            targets.push(folded);
        }
    }
    for (const [lo, hi] of ASTRAL_FOLD_BLOCKS) {
        for (let cp = lo; cp <= hi; cp++) {
            const folded = foldNonAsciiCodePoint(cp);
            if (folded !== cp) {
                sources.push(cp);
                targets.push(folded);
            }
        }
    }
    nonAsciiFoldTable = {
        sources: new Uint32Array(sources),
        targets: new Uint32Array(targets)
    };
    return nonAsciiFoldTable;
}

function findFirstAtOrAfter(arr, value) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function toCodePoints(str, caseSensitive) {
    const len = str.length;
    const out = new Uint32Array(len);
    let count = 0;
    let w0 = 0;
    let w1 = 0;
    let w2 = 0;
    let w3 = 0;
    for (let i = 0; i < len; i++) {
        const c = str.charCodeAt(i);
        let cp;
        if (c < ASCII_LIMIT) {
            cp = (!caseSensitive && c >= 0x41 && c <= 0x5a) ? (c | ASCII_CASE_BIT) : c;
        } else {
            const rawCp = str.codePointAt(i);
            if (rawCp > 0xffff) i++;
            cp = normalizeCodePoint(rawCp, caseSensitive);
        }
        out[count++] = cp;
        if (cp < ASCII_LIMIT) {
            if (cp < 64) {
                if (cp < 32) w0 |= 1 << cp;
                else w1 |= 1 << (cp & 31);
            } else {
                if (cp < 96) w2 |= 1 << (cp & 31);
                else w3 |= 1 << (cp & 31);
            }
        }
    }
    const codes = count === len ? out : out.subarray(0, count);
    return { codes, w0, w1, w2, w3 };
}

function hasDanglingEscape(pattern) {
    let trailingBackslashes = 0;
    for (let i = pattern.length - 1; i >= 0 && pattern.charCodeAt(i) === 0x5c; i--) {
        trailingBackslashes++;
    }
    return (trailingBackslashes & 1) === 1;
}

function stepBracketState(cp, index, state) {
    if (cp === 0x5b) {
        if (state.inClass) return false;
        state.inClass = true;
        state.classStart = index;
        state.memberCount = 0;
        return true;
    }
    if (cp === 0x5d) {
        if (!state.inClass || state.memberCount === 0) return false;
        state.inClass = false;
        return true;
    }
    if (!state.inClass) return true;
    const isInitialNegation = index === state.classStart + 1 && (cp === 0x21 || cp === 0x5e);
    if (!isInitialNegation) {
        state.memberCount++;
    }
    return true;
}

function hasBalancedBrackets(pattern) {
    const state = { inClass: false, classStart: 0, memberCount: 0 };
    for (let i = 0; i < pattern.length;) {
        const cp = pattern.codePointAt(i);
        const step = cp > 0xffff ? 2 : 1;
        if (cp === 0x5c) {
            if (state.inClass) state.memberCount++;
            i += 1;
            if (i < pattern.length) {
                const escCp = pattern.codePointAt(i);
                i += escCp > 0xffff ? 2 : 1;
            }
            continue;
        }
        if (!stepBracketState(cp, i, state)) {
            return false;
        }
        i += step;
    }
    return !state.inClass;
}

const SAFE_PATTERN_CACHE_LIMIT = 512;
const safePatternCache = new Map();

/**
 * Validates whether a glob pattern is syntactically well-formed and safe.
 *
 * @param {string} pattern - The glob pattern to validate.
 * @returns {boolean} True if the pattern is well-formed.
 */
export function isSafePattern(pattern) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return false;
    }
    const cached = safePatternCache.get(pattern);
    if (cached !== undefined) return cached;
    const safe = utf8Within(pattern, 512) && hasNonWhitespace(pattern) && !hasDanglingEscape(pattern) && hasBalancedBrackets(pattern);
    if (safePatternCache.size >= SAFE_PATTERN_CACHE_LIMIT) {
        safePatternCache.delete(safePatternCache.keys().next().value);
    }
    safePatternCache.set(pattern, safe);
    return safe;
}

function setAsciiBit(bits, cp) {
    bits[cp >>> 5] |= (1 << (cp & 31));
}

function addAsciiRangeBits(bits, lo, hi) {
    const loWord = lo >>> 5;
    const hiWord = hi >>> 5;
    for (let w = loWord; w <= hiWord; w++) {
        const startBit = w === loWord ? (lo & 31) : 0;
        const endBit = w === hiWord ? (hi & 31) : 31;
        const width = endBit - startBit + 1;
        const mask = width === 32 ? 0xffffffff : (((1 << width) - 1) << startBit) >>> 0;
        bits[w] = (bits[w] | mask) >>> 0;
    }
}

function addFoldedCodePoint(folded, asciiBits, unicodeSet) {
    if (folded < ASCII_LIMIT) {
        setAsciiBit(asciiBits, folded);
    } else {
        unicodeSet.add(folded);
    }
}

function addRawRange(rawStart, rawEnd, caseSensitive, asciiBits, unicodeSet, unicodeRanges) {
    if (rawStart > rawEnd) return;
    if (rawStart < ASCII_LIMIT) {
        addAsciiRangeBits(asciiBits, Math.max(0, rawStart), Math.min(rawEnd, ASCII_LIMIT - 1));
    }
    if (rawEnd >= ASCII_LIMIT) {
        const unicodeLo = Math.max(ASCII_LIMIT, rawStart);
        unicodeRanges.push(unicodeLo, rawEnd);
        if (!caseSensitive) {
            const { sources, targets } = getNonAsciiFoldTable();
            let idx = findFirstAtOrAfter(sources, unicodeLo);
            while (idx < sources.length && sources[idx] <= rawEnd) {
                addFoldedCodePoint(targets[idx], asciiBits, unicodeSet);
                idx++;
            }
        }
    }
}

function addRawSingle(rawCp, caseSensitive, asciiBits, unicodeSet) {
    addFoldedCodePoint(normalizeCodePoint(rawCp, caseSensitive), asciiBits, unicodeSet);
}

function compileCharClass(content, caseSensitive) {
    const firstCode = content.charCodeAt(0);
    const negated = firstCode === 0x21 || firstCode === 0x5e;
    const startIdx = negated ? 1 : 0;
    const len = content.length;
    if (startIdx >= len) {
        return { kind: 'unicode', match: () => false };
    }
    const asciiBits = new Uint32Array(4);
    const unicodeSet = new Set();
    const unicodeRanges = [];

    let i = startIdx;
    while (i < len) {
        if (content.charCodeAt(i) === 0x5c && i + 1 < len) {
            const rawCp = content.codePointAt(i + 1);
            addRawSingle(rawCp, caseSensitive, asciiBits, unicodeSet);
            i += 1 + (rawCp > 0xffff ? 2 : 1);
            continue;
        }
        const rawStart = content.codePointAt(i);
        const startStep = rawStart > 0xffff ? 2 : 1;
        const dashIdx = i + startStep;
        if (dashIdx + 1 < len && content.charCodeAt(dashIdx) === 0x2d && content.charCodeAt(dashIdx + 1) !== 0x5c) {
            const rawEnd = content.codePointAt(dashIdx + 1);
            const endStep = rawEnd > 0xffff ? 2 : 1;
            addRawRange(rawStart, rawEnd, caseSensitive, asciiBits, unicodeSet, unicodeRanges);
            i = dashIdx + 1 + endStep;
            continue;
        }
        addRawSingle(rawStart, caseSensitive, asciiBits, unicodeSet);
        i += startStep;
    }

    if (!caseSensitive) {
        asciiBits[3] |= (asciiBits[2] & ASCII_ALPHA_WORD_MASK);
    }

    if (unicodeSet.size === 0 && unicodeRanges.length === 0) {
        return {
            kind: 'ascii',
            bits: asciiBits,
            negatedBit: negated ? 1 : 0
        };
    }

    return {
        kind: 'unicode',
        match: (cp) => {
            let matched = false;
            if (cp < ASCII_LIMIT) {
                matched = ((asciiBits[cp >>> 5] >>> (cp & 31)) & 1) === 1;
            } else if (unicodeSet.has(cp)) {
                matched = true;
            } else {
                for (let r = 0; r < unicodeRanges.length; r += 2) {
                    if (cp >= unicodeRanges[r] && cp <= unicodeRanges[r + 1]) {
                        matched = true;
                        break;
                    }
                }
            }
            return negated ? !matched : matched;
        }
    };
}

function findClosingBracket(pattern, startIndex) {
    for (let j = startIndex; j < pattern.length;) {
        const cp = pattern.codePointAt(j);
        if (cp === 0x5c) {
            j += 1;
            if (j < pattern.length) {
                const escCp = pattern.codePointAt(j);
                j += escCp > 0xffff ? 2 : 1;
            }
            continue;
        }
        if (cp === 0x5d) {
            return j;
        }
        j += cp > 0xffff ? 2 : 1;
    }
    return -1;
}

function pushStarOp(rawOps) {
    if (rawOps.length === 0 || (rawOps[rawOps.length - 1] >>> OP_SHIFT) !== OP_STAR) {
        rawOps.push((OP_STAR << OP_SHIFT) >>> 0);
    }
}

function emitCharClassOp(compiledClass, rawOps, poolWords, unicodeMatchers) {
    if (compiledClass.kind === 'ascii') {
        const poolOffset = poolWords.length;
        const bits = compiledClass.bits;
        poolWords.push(bits[0], bits[1], bits[2], bits[3]);
        rawOps.push(((OP_ASCII_CLASS << OP_SHIFT) | (compiledClass.negatedBit << 28) | poolOffset) >>> 0);
        return;
    }
    const fnIdx = unicodeMatchers.length;
    unicodeMatchers.push(compiledClass.match);
    rawOps.push(((OP_UNICODE_CLASS << OP_SHIFT) | fnIdx) >>> 0);
}

function compileGlobBytecode(pattern, caseSensitive) {
    const len = pattern.length;
    const rawOps = [];
    const poolWords = [];
    const unicodeMatchers = [];
    let minLen = 0;
    let req0 = 0;
    let req1 = 0;
    let req2 = 0;
    let req3 = 0;
    let i = 0;

    const emitCharOp = (rawCp) => {
        const cp = normalizeCodePoint(rawCp, caseSensitive);
        rawOps.push(((OP_CHAR << OP_SHIFT) | cp) >>> 0);
        minLen++;
        if (cp < ASCII_LIMIT) {
            if (cp < 64) {
                if (cp < 32) req0 |= 1 << cp;
                else req1 |= 1 << (cp & 31);
            } else {
                if (cp < 96) req2 |= 1 << (cp & 31);
                else req3 |= 1 << (cp & 31);
            }
        }
    };

    while (i < len) {
        const cp = pattern.codePointAt(i);
        if (cp === 0x5c) {
            i++;
            if (i < len) {
                const escapedCp = pattern.codePointAt(i);
                emitCharOp(escapedCp);
                i += escapedCp > 0xffff ? 2 : 1;
            }
        } else if (cp === 0x2a) {
            pushStarOp(rawOps);
            i++;
        } else if (cp === 0x3f) {
            rawOps.push((OP_ANY << OP_SHIFT) >>> 0);
            minLen++;
            i++;
        } else if (cp === 0x5b) {
            const closeIdx = findClosingBracket(pattern, i + 1);
            if (closeIdx === -1) {
                emitCharOp(0x5b);
                i++;
            } else {
                const compiledClass = compileCharClass(pattern.slice(i + 1, closeIdx), caseSensitive);
                emitCharClassOp(compiledClass, rawOps, poolWords, unicodeMatchers);
                minLen++;
                i = closeIdx + 1;
            }
        } else {
            emitCharOp(cp);
            i += cp > 0xffff ? 2 : 1;
        }
    }

    return {
        ops: new Uint32Array(rawOps),
        asciiPool: new Uint32Array(poolWords),
        unicodeMatchers,
        minLen,
        req0,
        req1,
        req2,
        req3
    };
}

function matchCompiledTokens(compiled, targetInfo, maxSteps) {
    const targetCodes = targetInfo.codes ?? targetInfo;
    const targetLen = targetCodes.length;
    if (maxSteps === undefined) {
        if (targetLen < compiled.minLen) return false;
        if (targetInfo.codes !== undefined) {
            if (
                (compiled.req0 & targetInfo.w0) !== compiled.req0 ||
                (compiled.req1 & targetInfo.w1) !== compiled.req1 ||
                (compiled.req2 & targetInfo.w2) !== compiled.req2 ||
                (compiled.req3 & targetInfo.w3) !== compiled.req3
            ) {
                return false;
            }
        }
    }

    const { ops, asciiPool, unicodeMatchers } = compiled;
    const opsLen = ops.length;
    const stepBudget = maxSteps ?? DEFAULT_MAX_STEPS;

    let pIdx = 0;
    let tIdx = 0;
    let starPIdx = -1;
    let starTIdx = -1;
    let steps = 0;

    while (tIdx < targetLen) {
        if (++steps > stepBudget) {
            throw new StewardError('GLOB_COMPLEXITY', 'Glob evaluation exceeded execution step budget.');
        }
        if (pIdx < opsLen) {
            const word = ops[pIdx];
            const op = word >>> OP_SHIFT;
            if (op === OP_STAR) {
                starPIdx = pIdx++;
                if (maxSteps === undefined && pIdx === opsLen) {
                    return true;
                }
                if (pIdx < opsLen && (ops[pIdx] >>> OP_SHIFT) === OP_CHAR) {
                    const nextCp = ops[pIdx] & OP_PAYLOAD_MASK;
                    while (tIdx < targetLen && targetCodes[tIdx] !== nextCp) {
                        if (++steps > stepBudget) {
                            throw new StewardError('GLOB_COMPLEXITY', 'Glob evaluation exceeded execution step budget.');
                        }
                        tIdx++;
                    }
                    if (tIdx >= targetLen) return false;
                }
                starTIdx = tIdx;
                continue;
            }
            const cp = targetCodes[tIdx];
            let matched;
            if (op === OP_CHAR) {
                matched = (word & OP_PAYLOAD_MASK) === cp;
            } else if (op === OP_ANY) {
                matched = true;
            } else if (op === OP_ASCII_CLASS) {
                const hit = cp < ASCII_LIMIT
                    ? ((asciiPool[(word & ASCII_POOL_OFFSET_MASK) + (cp >>> 5)] >>> (cp & 31)) & 1)
                    : 0;
                matched = (hit ^ ((word >>> 28) & 1)) === 1;
            } else {
                matched = unicodeMatchers[word & OP_PAYLOAD_MASK](cp);
            }
            if (matched) {
                pIdx++;
                tIdx++;
                continue;
            }
        }
        if (starPIdx !== -1) {
            pIdx = starPIdx + 1;
            tIdx = ++starTIdx;
            if (pIdx < opsLen && (ops[pIdx] >>> OP_SHIFT) === OP_CHAR) {
                const nextCp = ops[pIdx] & OP_PAYLOAD_MASK;
                while (tIdx < targetLen && targetCodes[tIdx] !== nextCp) {
                    if (++steps > stepBudget) {
                        throw new StewardError('GLOB_COMPLEXITY', 'Glob evaluation exceeded execution step budget.');
                    }
                    tIdx++;
                }
                if (tIdx >= targetLen) return false;
                starTIdx = tIdx;
            }
            continue;
        }
        return false;
    }

    while (pIdx < opsLen && (ops[pIdx] >>> OP_SHIFT) === OP_STAR) {
        pIdx++;
    }
    return pIdx === opsLen;
}

const PATTERN_CACHE_LIMIT = 512;
const patternCacheInsensitive = new Map();
const patternCacheSensitive = new Map();

function getCompiledPattern(pattern, caseSensitive) {
    const cache = caseSensitive ? patternCacheSensitive : patternCacheInsensitive;
    let compiled = cache.get(pattern);
    if (compiled !== undefined) return compiled;
    compiled = compileGlobBytecode(pattern, caseSensitive);
    if (cache.size >= PATTERN_CACHE_LIMIT) {
        cache.delete(cache.keys().next().value);
    }
    cache.set(pattern, compiled);
    return compiled;
}

/**
 * Deterministic linear-time glob matching with packed 32-bit opcode bytecode and bit-level ASCII class lookup.
 * Enforces a fail-closed execution step budget (throws GLOB_COMPLEXITY on exhaustion).
 *
 * @param {string} pattern - Glob pattern (*, ?, [...], \).
 * @param {string} text - Candidate string to match against.
 * @param {object} [options] - Options.
 * @param {boolean} [options.caseSensitive=false] - Whether matching is case-sensitive.
 * @param {number} [options.maxSteps] - Optional hard execution step limit.
 * @returns {boolean} True if text matches pattern.
 */
export function matchGlob(pattern, text, { caseSensitive = false, maxSteps } = {}) {
    if (typeof pattern !== 'string' || typeof text !== 'string') return false;
    if (pattern === '*') return true;

    const compiled = getCompiledPattern(pattern, caseSensitive);
    if (maxSteps === undefined && text.length < compiled.minLen) return false;
    const targetInfo = toCodePoints(text, caseSensitive);
    return matchCompiledTokens(compiled, targetInfo, maxSteps);
}

function ensureBitWords(state, neededBits) {
    const neededWords = (neededBits + 31) >>> 5;
    if (state.unquotedBits === null) {
        state.unquotedBits = new Uint32Array(Math.max(4, neededWords));
        return;
    }
    if (neededWords > state.unquotedBits.length) {
        const grown = new Uint32Array(Math.max(neededWords, state.unquotedBits.length * 2));
        grown.set(state.unquotedBits);
        state.unquotedBits = grown;
    }
}

function setBitSpan(bits, fromIdx, toIdx) {
    for (let idx = fromIdx; idx < toIdx; idx++) {
        bits[idx >>> 5] |= (1 << (idx & 31));
    }
}

function appendSegmentText(state, str, isUnquoted) {
    const startPos = state.current.length;
    state.current += str;
    state.hasToken = true;
    if (!state.trackBraces) return;
    if (!isUnquoted) {
        if (!state.hasQuoted) {
            state.hasQuoted = true;
            if (startPos > 0) {
                ensureBitWords(state, startPos);
                setBitSpan(state.unquotedBits, 0, startPos);
            }
        }
        return;
    }
    if (!state.hasUnquotedBrace && (str.includes('{') || str.includes('}') || str.includes(','))) {
        state.hasUnquotedBrace = true;
    }
    if (state.hasQuoted) {
        const endPos = state.current.length;
        ensureBitWords(state, endPos);
        setBitSpan(state.unquotedBits, startPos, endPos);
    }
}

function flushArg(args, state, tokenSlots) {
    if (state.hasToken || state.current.length > 0) {
        args.push(state.current);
        if (tokenSlots !== null) {
            const len = state.current.length;
            let bits = null;
            if (state.hasUnquotedBrace && state.hasQuoted && state.unquotedBits !== null) {
                const words = (len + 31) >>> 5;
                bits = state.unquotedBits.subarray(0, words);
            }
            tokenSlots.push({
                kind: 'token',
                value: state.current,
                expandable: state.hasUnquotedBrace,
                unquotedBits: bits
            });
            state.hasQuoted = false;
            state.hasUnquotedBrace = false;
            state.unquotedBits = null;
        }
        state.current = '';
        state.hasToken = false;
    }
}

function isWhitespaceCode(code, text, i) {
    return code < ASCII_LIMIT ? (CHAR_FLAGS[code] & FLAG_WS) !== 0 : /\s/.test(text[i]);
}

function isOperatorCode(code) {
    return code < ASCII_LIMIT && (CHAR_FLAGS[code] & FLAG_OP) !== 0;
}

function isDoubleQuoteEscapable(code) {
    return code < ASCII_LIMIT && (CHAR_FLAGS[code] & FLAG_DBL_ESC) !== 0;
}

function skipLineContinuation(text, i) {
    if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) return i + 2;
    if (i + 2 < text.length && text.charCodeAt(i + 1) === 0x0d && text.charCodeAt(i + 2) === 0x0a) return i + 3;
    return -1;
}

function skipAllLineContinuations(text, idx) {
    while (idx < text.length && text.charCodeAt(idx) === 0x5c) {
        const next = skipLineContinuation(text, idx);
        if (next === -1) break;
        idx = next;
    }
    return idx;
}

function consumeSingleQuoted(text, i, state) {
    const closeIdx = text.indexOf("'", i);
    if (closeIdx === -1) {
        const rest = text.slice(i);
        if (rest) appendSegmentText(state, rest, false);
        return text.length;
    }
    if (closeIdx > i) {
        appendSegmentText(state, text.slice(i, closeIdx), false);
    }
    state.quote = QUOTE_NONE;
    return closeIdx + 1;
}

function hexDigitVal(code) {
    return code < ASCII_LIMIT ? HEX_TABLE[code] : -1;
}

function parseHexEscape(text, startIdx, maxDigits) {
    let val = 0;
    let digits = 0;
    let idx = startIdx;
    while (idx < text.length && digits < maxDigits) {
        const d = hexDigitVal(text.charCodeAt(idx));
        if (d < 0) break;
        val = val * 16 + d;
        digits++;
        idx++;
    }
    return { val, digits, nextIdx: idx };
}

function consumeAnsiCEscape(text, i, state) {
    if (i + 1 >= text.length) {
        appendSegmentText(state, '\\', false);
        return text.length;
    }
    const esc = text[i + 1];
    if (Object.hasOwn(ANSI_C_ESCAPES, esc)) {
        appendSegmentText(state, ANSI_C_ESCAPES[esc], false);
        return i + 2;
    }
    if (esc === 'x') {
        const { val, digits, nextIdx } = parseHexEscape(text, i + 2, 2);
        appendSegmentText(state, digits > 0 ? String.fromCharCode(val) : '\\x', false);
        return nextIdx;
    }
    if (esc === 'u' || esc === 'U') {
        const { val, digits, nextIdx } = parseHexEscape(text, i + 2, esc === 'u' ? 4 : 8);
        if (digits === 0) {
            appendSegmentText(state, '\\' + esc, false);
        } else {
            appendSegmentText(state, val >= 0 && val <= 0x10ffff ? String.fromCodePoint(val) : '\ufffd', false);
        }
        return nextIdx;
    }
    if (esc >= '0' && esc <= '7') {
        let val = 0;
        let digits = 0;
        let idx = i + 1;
        while (idx < text.length && digits < 3) {
            const c = text.charCodeAt(idx);
            if (c < 0x30 || c > 0x37) break;
            val = (val << 3) | (c - 0x30);
            digits++;
            idx++;
        }
        appendSegmentText(state, String.fromCharCode(val & 0xff), false);
        return idx;
    }
    if (esc === 'c' && i + 2 < text.length) {
        const ctrlCode = text.charCodeAt(i + 2);
        const mapped = ctrlCode === 0x3f ? 0x7f : ((ctrlCode & ~ASCII_CASE_BIT) ^ 0x40) & 0x7f;
        appendSegmentText(state, String.fromCharCode(mapped), false);
        return i + 3;
    }
    appendSegmentText(state, '\\' + esc, false);
    return i + 2;
}

function consumeAnsiCQuoted(text, i, state) {
    while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === 0x27) {
            state.quote = QUOTE_NONE;
            return i + 1;
        }
        if (code === 0x5c) {
            i = consumeAnsiCEscape(text, i, state);
            continue;
        }
        let end = i + 1;
        while (end < text.length) {
            const next = text.charCodeAt(end);
            if (next === 0x27 || next === 0x5c) break;
            end++;
        }
        appendSegmentText(state, end === i + 1 ? text[i] : text.slice(i, end), false);
        i = end;
    }
    return text.length;
}

function consumeDoubleQuoted(text, i, state) {
    const c = text[i];
    if (c === '"') {
        state.quote = QUOTE_NONE;
        return i + 1;
    }
    if (c === '\\') {
        const afterCont = skipLineContinuation(text, i);
        if (afterCont !== -1) return afterCont;
        if (i + 1 < text.length && isDoubleQuoteEscapable(text.charCodeAt(i + 1))) {
            appendSegmentText(state, text[i + 1], false);
            return i + 2;
        }
    }
    let end = i + 1;
    while (end < text.length) {
        const next = text.charCodeAt(end);
        if (next === 0x22 || next === 0x5c) break;
        end++;
    }
    appendSegmentText(state, end === i + 1 ? c : text.slice(i, end), false);
    return end;
}

function consumeUnquotedOperator(text, i, args, state, tokenSlots) {
    flushArg(args, state, tokenSlots);
    const c0 = text.charCodeAt(i);
    if (i + 2 < text.length && isThreeCharOperator(c0, text.charCodeAt(i + 1), text.charCodeAt(i + 2))) {
        const op = text.slice(i, i + 3);
        args.push(op);
        if (tokenSlots !== null) {
            tokenSlots.push({
                kind: IS_COMMAND_SEPARATOR.has(op) ? 'sep' : 'token',
                value: op,
                expandable: false,
                unquotedBits: null
            });
        }
        return i + 3;
    }
    if (i + 1 < text.length && isTwoCharOperator(c0, text.charCodeAt(i + 1))) {
        const op = text.slice(i, i + 2);
        args.push(op);
        if (tokenSlots !== null) {
            tokenSlots.push({
                kind: IS_COMMAND_SEPARATOR.has(op) ? 'sep' : 'token',
                value: op,
                expandable: false,
                unquotedBits: null
            });
        }
        return i + 2;
    }
    const op = text[i];
    args.push(op);
    if (tokenSlots !== null) {
        tokenSlots.push({
            kind: IS_COMMAND_SEPARATOR.has(op) ? 'sep' : 'token',
            value: op,
            expandable: false,
            unquotedBits: null
        });
    }
    return i + 1;
}

function consumeBackslashEscape(text, i, state) {
    const afterCont = skipLineContinuation(text, i);
    if (afterCont !== -1) return afterCont;
    state.hasToken = true;
    if (i + 1 < text.length) {
        appendSegmentText(state, text[i + 1], false);
        return i + 2;
    }
    appendSegmentText(state, '\\', false);
    return i + 1;
}

function consumeUnquotedStep(text, i, args, state, tokenSlots) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
        return consumeBackslashEscape(text, i, state);
    }
    if (code === 0x27) {
        state.quote = QUOTE_SINGLE;
        state.hasToken = true;
        return i + 1;
    }
    if (code === 0x22) {
        state.quote = QUOTE_DOUBLE;
        state.hasToken = true;
        return i + 1;
    }
    if (code === 0x24) {
        const afterDollar = skipAllLineContinuations(text, i + 1);
        if (afterDollar < text.length) {
            const nextCode = text.charCodeAt(afterDollar);
            if (nextCode === 0x27) {
                state.quote = QUOTE_ANSI_C;
                state.hasToken = true;
                return afterDollar + 1;
            }
            if (nextCode === 0x22) {
                state.quote = QUOTE_DOUBLE;
                state.hasToken = true;
                return afterDollar + 1;
            }
        }
    }
    if (isWhitespaceCode(code, text, i)) {
        flushArg(args, state, tokenSlots);
        if (tokenSlots !== null && code === 0x0a) {
            tokenSlots.push({ kind: 'sep', value: '\n', expandable: false, unquotedBits: null });
        }
        return i + 1;
    }
    if (isOperatorCode(code)) {
        return consumeUnquotedOperator(text, i, args, state, tokenSlots);
    }
    let end = i + 1;
    while (end < text.length) {
        const next = text.charCodeAt(end);
        if (next >= ASCII_LIMIT || (CHAR_FLAGS[next] & UNQUOTED_STOP_MASK) !== 0) break;
        end++;
    }
    appendSegmentText(state, end === i + 1 ? text[i] : text.slice(i, end), true);
    return end;
}

function runTokenizer(text, trackBraces) {
    if (typeof text !== 'string' || !hasNonWhitespace(text)) {
        return { args: [], tokenSlots: null };
    }
    const args = [];
    const tokenSlots = trackBraces ? [] : null;
    const state = {
        current: '',
        quote: QUOTE_NONE,
        hasToken: false,
        trackBraces,
        hasQuoted: false,
        hasUnquotedBrace: false,
        unquotedBits: null
    };
    let i = 0;

    while (i < text.length) {
        if (state.quote === QUOTE_SINGLE) {
            i = consumeSingleQuoted(text, i, state);
        } else if (state.quote === QUOTE_ANSI_C) {
            i = consumeAnsiCQuoted(text, i, state);
        } else if (state.quote === QUOTE_DOUBLE) {
            i = consumeDoubleQuoted(text, i, state);
        } else {
            i = consumeUnquotedStep(text, i, args, state, tokenSlots);
        }
    }

    flushArg(args, state, tokenSlots);
    return { args, tokenSlots };
}

/**
 * Tokenizes a command-line string following POSIX.1-2024 and extended shell lexical rules:
 * - Single quotes preserve all characters literally (including backslashes).
 * - ANSI-C $'...' quotes decode C/hex/unicode/octal/control escapes.
 * - Double quotes and $"..." allow escaping of ", \, $, `, and newline.
 * - Backslash-newline sequences outside single quotes are elided as line continuations.
 * - Unquoted 1-, 2-, and 3-character shell control and redirection operators delimit tokens.
 *
 * @param {string} text - Command line string.
 * @returns {string[]} Parsed arguments and operator tokens.
 */
export function tokenizeCommand(text) {
    return runTokenizer(text, false).args;
}

function isUnquotedAt(unquotedBits, idx) {
    return unquotedBits === null || ((unquotedBits[idx >>> 5] >>> (idx & 31)) & 1) === 1;
}

function isBraceOpenAt(text, unquotedBits, idx) {
    if (text.charCodeAt(idx) !== 0x7b) return false;
    if (!isUnquotedAt(unquotedBits, idx)) return false;
    if (idx > 0 && text.charCodeAt(idx - 1) === 0x24 && isUnquotedAt(unquotedBits, idx - 1)) {
        return false;
    }
    return true;
}

function findMatchingBraceGroupInSlot(text, unquotedBits, openIdx, endLimit) {
    let depth = 1;
    let paramDepth = 0;
    const branches = [];
    let branchStart = openIdx + 1;
    let overflow = false;
    for (let i = openIdx + 1; i < endLimit; i++) {
        if (!isUnquotedAt(unquotedBits, i)) continue;
        const code = text.charCodeAt(i);
        if (code === 0x7b) {
            if (i > 0 && text.charCodeAt(i - 1) === 0x24 && isUnquotedAt(unquotedBits, i - 1)) {
                paramDepth++;
                continue;
            }
            if (paramDepth === 0) {
                depth++;
                if (depth > MAX_BRACE_DEPTH) return null;
            }
        } else if (code === 0x7d) {
            if (paramDepth > 0) {
                paramDepth--;
                continue;
            }
            depth--;
            if (depth === 0) {
                if (branches.length === 0) return null;
                if (!overflow) {
                    branches.push(branchStart, i);
                }
                return { closeIdx: i, branches, overflow };
            }
        } else if (code === 0x2c && depth === 1 && paramDepth === 0) {
            if ((branches.length >>> 1) >= MAX_BRACE_BRANCHES) {
                overflow = true;
            } else {
                branches.push(branchStart, i);
                branchStart = i + 1;
            }
        }
    }
    return null;
}

function expandBraceSlice(text, unquotedBits, start, end, depth, budget) {
    if (depth > MAX_BRACE_DEPTH) {
        return [text.slice(start, end)];
    }
    for (let i = start; i < end; i++) {
        if (!isBraceOpenAt(text, unquotedBits, i)) continue;
        const group = findMatchingBraceGroupInSlot(text, unquotedBits, i, end);
        if (!group) continue;
        if (group.overflow) {
            throw new StewardError('GLOB_COMPLEXITY', 'Brace expansion exceeded branch limit.');
        }
        const prefix = text.slice(start, i);
        const suffixList = expandBraceSlice(text, unquotedBits, group.closeIdx + 1, end, depth + 1, budget);
        const midLists = [];
        let totalMidCount = 0;
        let sumMidChars = 0;
        const bArr = group.branches;
        for (let b = 0; b < bArr.length; b += 2) {
            const expandedBranch = expandBraceSlice(text, unquotedBits, bArr[b], bArr[b + 1], depth + 1, budget);
            midLists.push(expandedBranch);
            totalMidCount += expandedBranch.length;
            for (let k = 0; k < expandedBranch.length; k++) {
                sumMidChars += expandedBranch[k].length;
            }
        }
        const totalCount = totalMidCount * suffixList.length;
        if (totalCount > MAX_BRACE_CANDIDATES) {
            throw new StewardError('GLOB_COMPLEXITY', 'Brace expansion exceeded candidate limit.');
        }
        let sumSuffixChars = 0;
        for (let k = 0; k < suffixList.length; k++) {
            sumSuffixChars += suffixList[k].length;
        }
        const addedChars =
            totalCount * prefix.length +
            suffixList.length * sumMidChars +
            totalMidCount * sumSuffixChars;
        budget.remainingChars -= addedChars;
        if (budget.remainingChars < 0) {
            throw new StewardError('GLOB_COMPLEXITY', 'Brace expansion exceeded character budget.');
        }
        const out = [];
        for (let m = 0; m < midLists.length; m++) {
            const branchChoices = midLists[m];
            for (let c = 0; c < branchChoices.length; c++) {
                const preMid = prefix + branchChoices[c];
                for (let t = 0; t < suffixList.length; t++) {
                    out.push(preMid + suffixList[t]);
                }
            }
        }
        return out;
    }
    return [text.slice(start, end)];
}

function unescapeBacktickBody(raw, inDoubleQuote) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 0x5c && i + 1 < raw.length) {
            const nextCode = raw.charCodeAt(i + 1);
            if (
                nextCode === 0x24 ||
                nextCode === 0x60 ||
                nextCode === 0x5c ||
                (inDoubleQuote && nextCode === 0x22)
            ) {
                out += raw[i + 1];
                i++;
                continue;
            }
            if (nextCode === 0x0a) {
                i++;
                continue;
            }
            if (nextCode === 0x0d && i + 2 < raw.length && raw.charCodeAt(i + 2) === 0x0a) {
                i += 2;
                continue;
            }
        }
        out += raw[i];
    }
    return out;
}

function findMatchingBacktick(text, startIdx) {
    for (let i = startIdx; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0x5c) {
            const cont = skipLineContinuation(text, i);
            if (cont !== -1) {
                i = cont - 1;
                continue;
            }
            i++;
            continue;
        }
        if (code === 0x60) {
            return i;
        }
    }
    return -1;
}

function findDollarParenClose(text, startIdx) {
    const quoteStack = new Uint8Array(MAX_SUBST_DEPTH + 2);
    const parenStack = new Int32Array(MAX_SUBST_DEPTH + 2);
    let sp = 0;
    quoteStack[0] = QUOTE_NONE;
    parenStack[0] = 1;
    for (let i = startIdx; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const quote = quoteStack[sp];
        if (quote === QUOTE_SINGLE) {
            const closeIdx = text.indexOf("'", i);
            if (closeIdx === -1) return -1;
            quoteStack[sp] = QUOTE_NONE;
            i = closeIdx;
            continue;
        }
        if (quote === QUOTE_ANSI_C) {
            if (code === 0x5c) {
                i++;
                continue;
            }
            if (code === 0x27) quoteStack[sp] = QUOTE_NONE;
            continue;
        }
        if (quote === QUOTE_DOUBLE) {
            if (code === 0x5c) {
                const cont = skipLineContinuation(text, i);
                if (cont !== -1) {
                    i = cont - 1;
                    continue;
                }
                i++;
                continue;
            }
            if (code === 0x22) {
                quoteStack[sp] = QUOTE_NONE;
                continue;
            }
            if (code === 0x60) {
                const closeBt = findMatchingBacktick(text, i + 1);
                if (closeBt === -1) return -1;
                i = closeBt;
                continue;
            }
            if (code === 0x24) {
                const afterDollar = skipAllLineContinuations(text, i + 1);
                if (afterDollar < text.length && text.charCodeAt(afterDollar) === 0x28) {
                    if (sp + 1 > MAX_SUBST_DEPTH) {
                        throw new StewardError('GLOB_COMPLEXITY', 'Command substitution nesting exceeds limit.');
                    }
                    sp++;
                    quoteStack[sp] = QUOTE_NONE;
                    parenStack[sp] = 1;
                    i = afterDollar;
                }
            }
            continue;
        }
        if (code === 0x5c) {
            const cont = skipLineContinuation(text, i);
            if (cont !== -1) {
                i = cont - 1;
                continue;
            }
            i++;
            continue;
        }
        if (code === 0x27) {
            quoteStack[sp] = QUOTE_SINGLE;
            continue;
        }
        if (code === 0x22) {
            quoteStack[sp] = QUOTE_DOUBLE;
            continue;
        }
        if (code === 0x60) {
            const closeBt = findMatchingBacktick(text, i + 1);
            if (closeBt === -1) return -1;
            i = closeBt;
            continue;
        }
        if (code === 0x24) {
            const afterDollar = skipAllLineContinuations(text, i + 1);
            if (afterDollar < text.length) {
                const nextCode = text.charCodeAt(afterDollar);
                if (nextCode === 0x28) {
                    if (sp + 1 > MAX_SUBST_DEPTH) {
                        throw new StewardError('GLOB_COMPLEXITY', 'Command substitution nesting exceeds limit.');
                    }
                    sp++;
                    quoteStack[sp] = QUOTE_NONE;
                    parenStack[sp] = 1;
                    i = afterDollar;
                    continue;
                }
                if (nextCode === 0x27) {
                    quoteStack[sp] = QUOTE_ANSI_C;
                    i = afterDollar;
                    continue;
                }
                if (nextCode === 0x22) {
                    quoteStack[sp] = QUOTE_DOUBLE;
                    i = afterDollar;
                    continue;
                }
            }
        }
        if (code === 0x28) {
            parenStack[sp]++;
        } else if (code === 0x29) {
            parenStack[sp]--;
            if (parenStack[sp] === 0) {
                if (sp === 0) return i;
                sp--;
            }
        }
    }
    return -1;
}

function recordSubstitution(results, substCountBox, cmdText) {
    if (substCountBox.count >= MAX_SUBST_COUNT) {
        throw new StewardError('GLOB_COMPLEXITY', 'Command substitution count exceeds limit.');
    }
    substCountBox.count++;
    results.push(cmdText);
}

function collectImmediateSubstitutions(text, substCountBox) {
    if (!text.includes('$') && !text.includes('`')) return [];
    const results = [];
    let quote = QUOTE_NONE;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (quote === QUOTE_SINGLE) {
            const closeIdx = text.indexOf("'", i);
            if (closeIdx === -1) break;
            quote = QUOTE_NONE;
            i = closeIdx;
            continue;
        }
        if (quote === QUOTE_ANSI_C) {
            if (code === 0x5c) {
                i++;
                continue;
            }
            if (code === 0x27) quote = QUOTE_NONE;
            continue;
        }
        if (quote === QUOTE_DOUBLE) {
            if (code === 0x5c) {
                const cont = skipLineContinuation(text, i);
                if (cont !== -1) {
                    i = cont - 1;
                    continue;
                }
                i++;
                continue;
            }
            if (code === 0x22) {
                quote = QUOTE_NONE;
                continue;
            }
            if (code === 0x60) {
                const closeBt = findMatchingBacktick(text, i + 1);
                if (closeBt !== -1) {
                    recordSubstitution(results, substCountBox, unescapeBacktickBody(text.slice(i + 1, closeBt), true));
                    i = closeBt;
                }
                continue;
            }
            if (code === 0x24) {
                const afterDollar = skipAllLineContinuations(text, i + 1);
                if (afterDollar < text.length && text.charCodeAt(afterDollar) === 0x28) {
                    const closeParen = findDollarParenClose(text, afterDollar + 1);
                    if (closeParen !== -1) {
                        recordSubstitution(results, substCountBox, text.slice(afterDollar + 1, closeParen));
                        i = closeParen;
                    }
                }
            }
            continue;
        }
        if (code === 0x5c) {
            const cont = skipLineContinuation(text, i);
            if (cont !== -1) {
                i = cont - 1;
                continue;
            }
            i++;
            continue;
        }
        if (code === 0x27) {
            quote = QUOTE_SINGLE;
            continue;
        }
        if (code === 0x22) {
            quote = QUOTE_DOUBLE;
            continue;
        }
        if (code === 0x60) {
            const closeBt = findMatchingBacktick(text, i + 1);
            if (closeBt !== -1) {
                recordSubstitution(results, substCountBox, unescapeBacktickBody(text.slice(i + 1, closeBt), false));
                i = closeBt;
            }
            continue;
        }
        if (code === 0x24) {
            const afterDollar = skipAllLineContinuations(text, i + 1);
            if (afterDollar < text.length) {
                const nextCode = text.charCodeAt(afterDollar);
                if (nextCode === 0x27) {
                    quote = QUOTE_ANSI_C;
                    i = afterDollar;
                    continue;
                }
                if (nextCode === 0x22) {
                    quote = QUOTE_DOUBLE;
                    i = afterDollar;
                    continue;
                }
                if (nextCode === 0x28) {
                    const closeParen = findDollarParenClose(text, afterDollar + 1);
                    if (closeParen !== -1) {
                        recordSubstitution(results, substCountBox, text.slice(afterDollar + 1, closeParen));
                        i = closeParen;
                    }
                }
            }
        }
    }
    return results;
}

function expandCommandText(originalText, text, tokens, tokenSet, expandedCommands, expandedSet, braceBudget, substCountBox, depth) {
    const { tokenSlots } = runTokenizer(text, true);
    if (tokenSlots !== null && tokenSlots.length > 0) {
        const subcommands = [];
        const fullParts = [];
        let currentSub = [];
        for (let i = 0; i < tokenSlots.length; i++) {
            const slot = tokenSlots[i];
            if (slot.kind === 'sep') {
                if (currentSub.length > 0) {
                    subcommands.push(currentSub);
                    currentSub = [];
                }
                if (slot.value !== '\n') {
                    if (!tokenSet.has(slot.value)) {
                        tokenSet.add(slot.value);
                        tokens.push(slot.value);
                    }
                    fullParts.push(slot.value);
                }
                continue;
            }
            fullParts.push(slot.value);
            currentSub.push(slot);
        }
        if (currentSub.length > 0) {
            subcommands.push(currentSub);
        }

        if (fullParts.length > 0) {
            const fullJoined = fullParts.join(' ');
            if (fullJoined !== originalText && !expandedSet.has(fullJoined)) {
                expandedSet.add(fullJoined);
                expandedCommands.push(fullJoined);
            }
        }

        for (let s = 0; s < subcommands.length; s++) {
            const subSlots = subcommands[s];
            const perSlotChoices = [];
            const rawParts = [];
            let anyExpanded = false;
            for (let k = 0; k < subSlots.length; k++) {
                const slot = subSlots[k];
                rawParts.push(slot.value);
                if (!slot.expandable) {
                    if (!tokenSet.has(slot.value)) {
                        tokenSet.add(slot.value);
                        tokens.push(slot.value);
                    }
                    perSlotChoices.push([slot.value]);
                } else {
                    const choices = expandBraceSlice(slot.value, slot.unquotedBits, 0, slot.value.length, 0, braceBudget);
                    if (choices.length > 1) anyExpanded = true;
                    for (let c = 0; c < choices.length; c++) {
                        if (!tokenSet.has(choices[c])) {
                            tokenSet.add(choices[c]);
                            tokens.push(choices[c]);
                        }
                    }
                    perSlotChoices.push(choices);
                }
            }
            const subJoined = rawParts.join(' ');
            if (subJoined !== originalText && !expandedSet.has(subJoined)) {
                expandedSet.add(subJoined);
                expandedCommands.push(subJoined);
            }
            if (anyExpanded) {
                let combinations = [''];
                for (let k = 0; k < perSlotChoices.length; k++) {
                    const choices = perSlotChoices[k];
                    const nextCount = combinations.length * choices.length;
                    if (nextCount > MAX_BRACE_CANDIDATES) {
                        throw new StewardError('GLOB_COMPLEXITY', 'Brace command expansion exceeded candidate limit.');
                    }
                    const next = [];
                    for (let b = 0; b < combinations.length; b++) {
                        const base = combinations[b];
                        for (let c = 0; c < choices.length; c++) {
                            const combined = base ? `${base} ${choices[c]}` : choices[c];
                            braceBudget.remainingChars -= combined.length;
                            if (braceBudget.remainingChars < 0) {
                                throw new StewardError('GLOB_COMPLEXITY', 'Brace command expansion exceeded character budget.');
                            }
                            next.push(combined);
                        }
                    }
                    combinations = next;
                }
                for (let k = 0; k < combinations.length; k++) {
                    const cmd = combinations[k];
                    if (cmd !== originalText && !expandedSet.has(cmd)) {
                        expandedSet.add(cmd);
                        expandedCommands.push(cmd);
                    }
                }
            }
        }
    }

    const innerCommands = collectImmediateSubstitutions(text, substCountBox);
    if (innerCommands.length > 0) {
        if (depth >= MAX_SUBST_DEPTH) {
            throw new StewardError('GLOB_COMPLEXITY', 'Command substitution nesting exceeds limit.');
        }
        for (let i = 0; i < innerCommands.length; i++) {
            const inner = innerCommands[i];
            if (inner !== originalText && !expandedSet.has(inner)) {
                expandedSet.add(inner);
                expandedCommands.push(inner);
            }
            expandCommandText(originalText, inner, tokens, tokenSet, expandedCommands, expandedSet, braceBudget, substCountBox, depth + 1);
        }
    }
}

function expandAndNormalizeCommand(text) {
    const tokens = [];
    const tokenSet = new Set();
    const expandedCommands = [];
    const expandedSet = new Set();
    const braceBudget = { remainingChars: MAX_BRACE_EXPANDED_CHARS };
    const substCountBox = { count: 0 };
    expandCommandText(text, text, tokens, tokenSet, expandedCommands, expandedSet, braceBudget, substCountBox, 0);
    return { tokens, expandedCommands };
}

const patternsCacheInsensitive = new WeakMap();
const patternsCacheSensitive = new WeakMap();

function isSamePatternArray(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function compilePatterns(patterns, caseSensitive) {
    const cache = caseSensitive ? patternsCacheSensitive : patternsCacheInsensitive;
    const cached = cache.get(patterns);
    if (cached !== undefined && isSamePatternArray(cached.snap, patterns)) {
        return cached;
    }
    const compiled = [];
    for (let i = 0; i < patterns.length; i++) {
        const pat = patterns[i];
        if (typeof pat !== 'string') continue;
        if (pat === '*') {
            const entry = { snap: patterns.slice(), matchAll: true, compiled: [] };
            cache.set(patterns, entry);
            return entry;
        }
        compiled.push(getCompiledPattern(pat, caseSensitive));
    }
    const entry = { snap: patterns.slice(), matchAll: false, compiled };
    cache.set(patterns, entry);
    return entry;
}

function matchesAnyCompiled(compiled, targetInfo, maxSteps) {
    for (let i = 0; i < compiled.length; i++) {
        if (matchCompiledTokens(compiled[i], targetInfo, maxSteps)) return true;
    }
    return false;
}

/**
 * Precomputes full-string, normalized, brace-expanded, substitution, and per-token code-point arrays for repeated glob evaluations.
 *
 * @param {string} text - Command or text to tokenize and convert to code points.
 * @param {boolean} [caseSensitive=false] - Whether matching is case-sensitive.
 * @returns {{ fullTarget: Uint32Array, tokenTargets: Uint32Array[], expandedTargets: Uint32Array[] }}
 */
export function prepareGlobTargets(text, caseSensitive = false) {
    if (typeof text !== 'string') {
        return {
            fullTarget: new Uint32Array(0),
            tokenTargets: [],
            expandedTargets: [],
            fullInfo: { codes: new Uint32Array(0), w0: 0, w1: 0, w2: 0, w3: 0 },
            tokenInfos: [],
            expandedInfos: []
        };
    }
    const fullInfo = toCodePoints(text, caseSensitive);
    const { tokens, expandedCommands } = expandAndNormalizeCommand(text);
    const tokenInfos = new Array(tokens.length);
    const tokenTargets = new Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
        const info = toCodePoints(tokens[i], caseSensitive);
        tokenInfos[i] = info;
        tokenTargets[i] = info.codes;
    }
    const expandedInfos = new Array(expandedCommands.length);
    const expandedTargets = new Array(expandedCommands.length);
    for (let i = 0; i < expandedCommands.length; i++) {
        const info = toCodePoints(expandedCommands[i], caseSensitive);
        expandedInfos[i] = info;
        expandedTargets[i] = info.codes;
    }
    return {
        fullTarget: fullInfo.codes,
        tokenTargets,
        expandedTargets,
        fullInfo,
        tokenInfos,
        expandedInfos
    };
}

/**
 * Matches patterns against the full text, normalized/subcommand/substitution variants, expanded braces, and shell tokens.
 *
 * @param {string[]} patterns - Glob patterns to evaluate.
 * @param {string} text - Target command or text.
 * @param {object} [options] - Evaluation options.
 * @returns {boolean} True if any pattern matches the full text or any token.
 */
export function matchArgGlob(patterns, text, options = {}) {
    if (!Array.isArray(patterns) || patterns.length === 0 || typeof text !== 'string') return false;
    const caseSensitive = Boolean(options.caseSensitive);
    const maxSteps = options.maxSteps;
    const { matchAll, compiled } = compilePatterns(patterns, caseSensitive);
    if (matchAll) return true;
    if (compiled.length === 0) return false;

    const prepared = options.preparedTargets;
    if (prepared !== undefined) {
        const fullInfo = prepared.fullInfo ?? prepared.fullTarget;
        if (matchesAnyCompiled(compiled, fullInfo, maxSteps)) return true;
        const expList = prepared.expandedInfos ?? prepared.expandedTargets;
        if (expList) {
            for (let i = 0; i < expList.length; i++) {
                if (matchesAnyCompiled(compiled, expList[i], maxSteps)) return true;
            }
        }
        const tokList = prepared.tokenInfos ?? prepared.tokenTargets;
        for (let i = 0; i < tokList.length; i++) {
            if (matchesAnyCompiled(compiled, tokList[i], maxSteps)) return true;
        }
        return false;
    }

    const fullInfo = toCodePoints(text, caseSensitive);
    if (matchesAnyCompiled(compiled, fullInfo, maxSteps)) return true;

    const { tokens, expandedCommands } = expandAndNormalizeCommand(text);
    for (let i = 0; i < expandedCommands.length; i++) {
        if (matchesAnyCompiled(compiled, toCodePoints(expandedCommands[i], caseSensitive), maxSteps)) return true;
    }
    for (let i = 0; i < tokens.length; i++) {
        if (matchesAnyCompiled(compiled, toCodePoints(tokens[i], caseSensitive), maxSteps)) return true;
    }
    return false;
}
