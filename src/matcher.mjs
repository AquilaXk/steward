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

const QUOTE_NONE = 0;
const QUOTE_SINGLE = 1;
const QUOTE_DOUBLE = 2;
const QUOTE_ANSI_C = 3;

const MAX_BRACE_CANDIDATES = 32;
const MAX_BRACE_DEPTH = 4;

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
    while (end > 0 && str.codePointAt(end - 1) === 0x2f) {
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
        const c = str.codePointAt(i);
        const isDigit = c >= 0x30 && c <= 0x39;
        const isHexLower = c >= 0x61 && c <= 0x66;
        if (!isDigit && !isHexLower) return false;
    }
    return true;
}

function isThreeCharOperator(c0, c1, c2) {
    const packed = (c0 << 16) | (c1 << 8) | c2;
    return (
        packed === 0x263e3e || // &>>
        packed === 0x3c3c3c || // <<<
        packed === 0x3b3b26    // ;;&
    );
}

function isTwoCharOperator(c0, c1) {
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

function normalizeCodePoint(cp, caseSensitive) {
    if (caseSensitive) return cp;
    if (cp >= 0x41 && cp <= 0x5a) return cp | ASCII_CASE_BIT;
    if (cp < ASCII_LIMIT) return cp;
    return String.fromCodePoint(cp).toLowerCase().codePointAt(0);
}

function toCodePoints(str, caseSensitive) {
    const len = str.length;
    const out = new Uint32Array(len);
    let count = 0;
    for (let i = 0; i < len; i++) {
        const c = str.charCodeAt(i);
        if (c < ASCII_LIMIT) {
            out[count++] = (!caseSensitive && c >= 0x41 && c <= 0x5a) ? (c | ASCII_CASE_BIT) : c;
        } else {
            const cp = str.codePointAt(i);
            if (cp > 0xffff) i++;
            out[count++] = normalizeCodePoint(cp, caseSensitive);
        }
    }
    return count === len ? out : out.subarray(0, count);
}

function hasDanglingEscape(pattern) {
    let trailingBackslashes = 0;
    for (let i = pattern.length - 1; i >= 0 && pattern.codePointAt(i) === 0x5c; i--) {
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
        safePatternCache.clear();
    }
    safePatternCache.set(pattern, safe);
    return safe;
}

function setAsciiBit(bits, cp) {
    bits[cp >>> 5] |= (1 << (cp & 31));
}

function addRawRange(rawStart, rawEnd, caseSensitive, asciiBits, unicodeSet, unicodeRanges) {
    if (rawStart > rawEnd) return;
    const asciiEnd = Math.min(rawEnd, ASCII_LIMIT - 1);
    for (let cp = Math.max(0, rawStart); cp <= asciiEnd; cp++) {
        setAsciiBit(asciiBits, cp);
    }
    if (rawEnd >= ASCII_LIMIT) {
        const unicodeLo = Math.max(ASCII_LIMIT, rawStart);
        unicodeRanges.push(unicodeLo, rawEnd);
        if (!caseSensitive && rawEnd - unicodeLo <= 512) {
            for (let cp = unicodeLo; cp <= rawEnd; cp++) {
                const folded = normalizeCodePoint(cp, false);
                if (folded !== cp) unicodeSet.add(folded);
            }
        }
    }
}

function addRawSingle(rawCp, caseSensitive, asciiBits, unicodeSet) {
    if (rawCp < ASCII_LIMIT) {
        setAsciiBit(asciiBits, rawCp);
    } else {
        unicodeSet.add(normalizeCodePoint(rawCp, caseSensitive));
    }
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
    let i = 0;

    while (i < len) {
        const cp = pattern.codePointAt(i);
        if (cp === 0x5c) {
            i++;
            if (i < len) {
                const escapedCp = pattern.codePointAt(i);
                rawOps.push(((OP_CHAR << OP_SHIFT) | normalizeCodePoint(escapedCp, caseSensitive)) >>> 0);
                i += escapedCp > 0xffff ? 2 : 1;
            }
        } else if (cp === 0x2a) {
            pushStarOp(rawOps);
            i++;
        } else if (cp === 0x3f) {
            rawOps.push((OP_ANY << OP_SHIFT) >>> 0);
            i++;
        } else if (cp === 0x5b) {
            const closeIdx = findClosingBracket(pattern, i + 1);
            if (closeIdx === -1) {
                rawOps.push(((OP_CHAR << OP_SHIFT) | normalizeCodePoint(0x5b, caseSensitive)) >>> 0);
                i++;
            } else {
                const compiledClass = compileCharClass(pattern.slice(i + 1, closeIdx), caseSensitive);
                emitCharClassOp(compiledClass, rawOps, poolWords, unicodeMatchers);
                i = closeIdx + 1;
            }
        } else {
            rawOps.push(((OP_CHAR << OP_SHIFT) | normalizeCodePoint(cp, caseSensitive)) >>> 0);
            i += cp > 0xffff ? 2 : 1;
        }
    }

    return {
        ops: new Uint32Array(rawOps),
        asciiPool: new Uint32Array(poolWords),
        unicodeMatchers
    };
}

function matchCompiledTokens(compiled, targetCodes, maxSteps) {
    const { ops, asciiPool, unicodeMatchers } = compiled;
    const opsLen = ops.length;
    const targetLen = targetCodes.length;
    const stepBudget = maxSteps ?? Math.max(100000, (opsLen + 2) * targetLen);

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
        cache.clear();
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
    const targetCodes = toCodePoints(text, caseSensitive);
    return matchCompiledTokens(compiled, targetCodes, maxSteps);
}

function appendSegmentChar(state, ch, isUnquoted) {
    state.current += ch;
    state.hasToken = true;
    if (state.segments === null) return;
    if (isUnquoted && (ch === '{' || ch === '}' || ch === ',')) {
        state.hasUnquotedBrace = true;
    }
    const segs = state.segments;
    const lastIdx = segs.length - 1;
    if (lastIdx >= 0 && segs[lastIdx].unquoted === isUnquoted) {
        segs[lastIdx].text += ch;
    } else {
        segs.push({ text: ch, unquoted: isUnquoted });
    }
}

function flushArg(args, state, tokenSlots) {
    if (state.hasToken || state.current.length > 0) {
        args.push(state.current);
        if (tokenSlots !== null) {
            tokenSlots.push({
                value: state.current,
                segments: state.hasUnquotedBrace ? state.segments : null
            });
            state.segments = [];
            state.hasUnquotedBrace = false;
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
    if (i + 1 < text.length && text.codePointAt(i + 1) === 0x0a) return i + 2;
    if (i + 2 < text.length && text.codePointAt(i + 1) === 0x0d && text.codePointAt(i + 2) === 0x0a) return i + 3;
    return -1;
}

function consumeSingleQuoted(text, i, state) {
    const closeIdx = text.indexOf("'", i);
    if (closeIdx === -1) {
        const rest = text.slice(i);
        if (rest) appendSegmentChar(state, rest, false);
        return text.length;
    }
    if (closeIdx > i) {
        appendSegmentChar(state, text.slice(i, closeIdx), false);
    }
    state.quote = QUOTE_NONE;
    return closeIdx + 1;
}

function hexDigitVal(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x46) return code - 0x37;
    if (code >= 0x61 && code <= 0x66) return code - 0x57;
    return -1;
}

function parseHexEscape(text, startIdx, maxDigits) {
    let val = 0;
    let digits = 0;
    let idx = startIdx;
    while (idx < text.length && digits < maxDigits) {
        const d = hexDigitVal(text.codePointAt(idx));
        if (d < 0) break;
        val = (val << 4) | d;
        digits++;
        idx++;
    }
    return { val, digits, nextIdx: idx };
}

function consumeAnsiCEscape(text, i, state) {
    if (i + 1 >= text.length) {
        appendSegmentChar(state, '\\', false);
        return text.length;
    }
    const esc = text[i + 1];
    if (Object.hasOwn(ANSI_C_ESCAPES, esc)) {
        appendSegmentChar(state, ANSI_C_ESCAPES[esc], false);
        return i + 2;
    }
    if (esc === 'x') {
        const { val, digits, nextIdx } = parseHexEscape(text, i + 2, 2);
        appendSegmentChar(state, digits > 0 ? String.fromCharCode(val) : '\\x', false);
        return nextIdx;
    }
    if (esc === 'u' || esc === 'U') {
        const { val, digits, nextIdx } = parseHexEscape(text, i + 2, esc === 'u' ? 4 : 8);
        if (digits === 0) {
            appendSegmentChar(state, '\\' + esc, false);
        } else {
            appendSegmentChar(state, val <= 0x10ffff ? String.fromCodePoint(val) : '\ufffd', false);
        }
        return nextIdx;
    }
    if (esc >= '0' && esc <= '7') {
        let val = 0;
        let digits = 0;
        let idx = i + 1;
        while (idx < text.length && digits < 3) {
            const c = text.codePointAt(idx);
            if (c < 0x30 || c > 0x37) break;
            val = (val << 3) | (c - 0x30);
            digits++;
            idx++;
        }
        appendSegmentChar(state, String.fromCharCode(val & 0xff), false);
        return idx;
    }
    if (esc === 'c' && i + 2 < text.length) {
        const ctrlCode = text.codePointAt(i + 2);
        const mapped = ctrlCode === 0x3f ? 0x7f : ((ctrlCode & ~ASCII_CASE_BIT) ^ 0x40) & 0x7f;
        appendSegmentChar(state, String.fromCharCode(mapped), false);
        return i + 3;
    }
    appendSegmentChar(state, '\\' + esc, false);
    return i + 2;
}

function consumeAnsiCQuoted(text, i, state) {
    while (i < text.length) {
        const ch = text[i];
        if (ch === "'") {
            state.quote = QUOTE_NONE;
            return i + 1;
        }
        if (ch === '\\') {
            i = consumeAnsiCEscape(text, i, state);
            continue;
        }
        appendSegmentChar(state, ch, false);
        i++;
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
            if (state.segments === null) {
                state.current += text[i + 1];
                state.hasToken = true;
            } else {
                appendSegmentChar(state, text[i + 1], false);
            }
            return i + 2;
        }
    }
    if (state.segments === null) {
        state.current += c;
        state.hasToken = true;
    } else {
        appendSegmentChar(state, c, false);
    }
    return i + 1;
}

function consumeUnquotedOperator(text, i, args, state, tokenSlots) {
    flushArg(args, state, tokenSlots);
    const c0 = text.codePointAt(i);
    if (i + 2 < text.length && isThreeCharOperator(c0, text.codePointAt(i + 1), text.codePointAt(i + 2))) {
        const op = text.slice(i, i + 3);
        args.push(op);
        if (tokenSlots !== null) tokenSlots.push({ value: op, segments: null });
        return i + 3;
    }
    if (i + 1 < text.length && isTwoCharOperator(c0, text.codePointAt(i + 1))) {
        const op = text.slice(i, i + 2);
        args.push(op);
        if (tokenSlots !== null) tokenSlots.push({ value: op, segments: null });
        return i + 2;
    }
    const op = text[i];
    args.push(op);
    if (tokenSlots !== null) tokenSlots.push({ value: op, segments: null });
    return i + 1;
}

function consumeBackslashEscape(text, i, state) {
    const afterCont = skipLineContinuation(text, i);
    if (afterCont !== -1) return afterCont;
    state.hasToken = true;
    if (i + 1 < text.length) {
        appendSegmentChar(state, text[i + 1], false);
        return i + 2;
    }
    appendSegmentChar(state, '\\', false);
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
    if (code === 0x24 && i + 1 < text.length) {
        const nextCode = text.charCodeAt(i + 1);
        if (nextCode === 0x27) {
            state.quote = QUOTE_ANSI_C;
            state.hasToken = true;
            return i + 2;
        }
        if (nextCode === 0x22) {
            state.quote = QUOTE_DOUBLE;
            state.hasToken = true;
            return i + 2;
        }
    }
    if (isWhitespaceCode(code, text, i)) {
        flushArg(args, state, tokenSlots);
        return i + 1;
    }
    if (isOperatorCode(code)) {
        return consumeUnquotedOperator(text, i, args, state, tokenSlots);
    }
    if (state.segments === null) {
        state.current += text[i];
        state.hasToken = true;
    } else {
        appendSegmentChar(state, text[i], true);
    }
    return i + 1;
}

function runTokenizer(text, collectBraces) {
    if (typeof text !== 'string' || !hasNonWhitespace(text)) {
        return { args: [], tokenSlots: null };
    }
    const args = [];
    const tokenSlots = collectBraces ? [] : null;
    const state = {
        current: '',
        quote: QUOTE_NONE,
        hasToken: false,
        segments: collectBraces ? [] : null,
        hasUnquotedBrace: false
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

function flattenSegmentsToUnits(segments) {
    const units = [];
    for (const seg of segments) {
        for (const ch of seg.text) {
            const isDollarPrefix = units.length > 0 && units[units.length - 1].ch === '$' && units[units.length - 1].unquoted;
            units.push({ ch, unquoted: seg.unquoted && !(ch === '{' && isDollarPrefix) });
        }
    }
    return units;
}

function findMatchingBraceGroup(units, openIdx) {
    let depth = 1;
    const branches = [];
    let branchStart = openIdx + 1;
    for (let i = openIdx + 1; i < units.length; i++) {
        const u = units[i];
        if (!u.unquoted) continue;
        if (u.ch === '{') {
            depth++;
            if (depth > MAX_BRACE_DEPTH) return null;
        } else if (u.ch === '}') {
            depth--;
            if (depth === 0) {
                if (branches.length === 0) return null;
                branches.push(units.slice(branchStart, i));
                return { closeIdx: i, branches };
            }
        } else if (u.ch === ',' && depth === 1) {
            branches.push(units.slice(branchStart, i));
            branchStart = i + 1;
            if (branches.length >= MAX_BRACE_CANDIDATES) break;
        }
    }
    return null;
}

function unitsToText(units) {
    let out = '';
    for (const u of units) out += u.ch;
    return out;
}

function expandBraceUnits(units, depth) {
    if (depth > MAX_BRACE_DEPTH) return [unitsToText(units)];
    for (let i = 0; i < units.length; i++) {
        if (!units[i].unquoted || units[i].ch !== '{') continue;
        const group = findMatchingBraceGroup(units, i);
        if (!group) continue;
        const prefix = units.slice(0, i);
        const suffixExpansions = expandBraceUnits(units.slice(group.closeIdx + 1), depth + 1);
        const prefixText = unitsToText(prefix);
        const expanded = [];
        for (const branch of group.branches) {
            const midExpansions = expandBraceUnits(branch, depth + 1);
            for (const mid of midExpansions) {
                for (const tail of suffixExpansions) {
                    expanded.push(prefixText + mid + tail);
                    if (expanded.length >= MAX_BRACE_CANDIDATES) return expanded;
                }
            }
        }
        return expanded;
    }
    return [unitsToText(units)];
}

function expandCommandBraces(text) {
    if (!text.includes('{')) {
        return {
            tokens: tokenizeCommand(text),
            expandedCommands: []
        };
    }
    const { tokenSlots } = runTokenizer(text, true);
    if (!tokenSlots || tokenSlots.length === 0) {
        return { tokens: [], expandedCommands: [] };
    }
    const tokens = [];
    const perSlotChoices = [];
    let anyExpanded = false;

    for (const slot of tokenSlots) {
        if (!slot.segments) {
            tokens.push(slot.value);
            perSlotChoices.push([slot.value]);
            continue;
        }
        const choices = expandBraceUnits(flattenSegmentsToUnits(slot.segments), 0);
        if (choices.length > 1) anyExpanded = true;
        for (const c of choices) tokens.push(c);
        perSlotChoices.push(choices);
    }

    const expandedCommands = [];
    if (anyExpanded) {
        let combinations = [''];
        for (const choices of perSlotChoices) {
            const next = [];
            for (const base of combinations) {
                for (const c of choices) {
                    next.push(base ? `${base} ${c}` : c);
                    if (next.length >= MAX_BRACE_CANDIDATES) break;
                }
                if (next.length >= MAX_BRACE_CANDIDATES) break;
            }
            combinations = next;
        }
        for (const cmd of combinations) {
            if (cmd !== text) expandedCommands.push(cmd);
        }
    }
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

function matchesAnyCompiled(compiled, targetCodes, maxSteps) {
    for (let i = 0; i < compiled.length; i++) {
        if (matchCompiledTokens(compiled[i], targetCodes, maxSteps)) return true;
    }
    return false;
}

/**
 * Precomputes full-string, brace-expanded, and per-token code-point arrays for repeated glob evaluations.
 *
 * @param {string} text - Command or text to tokenize and convert to code points.
 * @param {boolean} [caseSensitive=false] - Whether matching is case-sensitive.
 * @returns {{ fullTarget: Uint32Array, tokenTargets: Uint32Array[], expandedTargets: Uint32Array[] }}
 */
export function prepareGlobTargets(text, caseSensitive = false) {
    if (typeof text !== 'string') {
        return { fullTarget: new Uint32Array(0), tokenTargets: [], expandedTargets: [] };
    }
    const fullTarget = toCodePoints(text, caseSensitive);
    const { tokens, expandedCommands } = expandCommandBraces(text);
    const tokenTargets = tokens.map(tok => toCodePoints(tok, caseSensitive));
    const expandedTargets = expandedCommands.map(cmd => toCodePoints(cmd, caseSensitive));
    return { fullTarget, tokenTargets, expandedTargets };
}

/**
 * Matches patterns against both the full text and parsed shell argument tokens (including bounded unquoted braces).
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
        if (matchesAnyCompiled(compiled, prepared.fullTarget, maxSteps)) return true;
        if (prepared.expandedTargets) {
            for (let i = 0; i < prepared.expandedTargets.length; i++) {
                if (matchesAnyCompiled(compiled, prepared.expandedTargets[i], maxSteps)) return true;
            }
        }
        for (let i = 0; i < prepared.tokenTargets.length; i++) {
            if (matchesAnyCompiled(compiled, prepared.tokenTargets[i], maxSteps)) return true;
        }
        return false;
    }

    const fullTarget = toCodePoints(text, caseSensitive);
    if (matchesAnyCompiled(compiled, fullTarget, maxSteps)) return true;

    if (text.includes('{')) {
        const { tokens, expandedCommands } = expandCommandBraces(text);
        for (let i = 0; i < expandedCommands.length; i++) {
            if (matchesAnyCompiled(compiled, toCodePoints(expandedCommands[i], caseSensitive), maxSteps)) return true;
        }
        for (let i = 0; i < tokens.length; i++) {
            if (matchesAnyCompiled(compiled, toCodePoints(tokens[i], caseSensitive), maxSteps)) return true;
        }
        return false;
    }

    const tokens = tokenizeCommand(text);
    for (let i = 0; i < tokens.length; i++) {
        if (matchesAnyCompiled(compiled, toCodePoints(tokens[i], caseSensitive), maxSteps)) return true;
    }
    return false;
}
