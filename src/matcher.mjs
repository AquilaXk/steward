import { StewardError } from './errors.mjs';

const ASCII_LIMIT = 128;
const ASCII_CASE_BIT = 0x20;

const TOK_STAR = 1;
const TOK_ANY = 2;
const TOK_CHAR = 3;
const TOK_CLASS = 4;

const FLAG_WS = 1 << 0;
const FLAG_OP = 1 << 1;
const FLAG_DBL_ESC = 1 << 2;

const QUOTE_NONE = 0;
const QUOTE_SINGLE = 1;
const QUOTE_DOUBLE = 2;

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

const TWO_CHAR_OPS = new Set(['&&', '||', ';;', '<<', '>>', '<&', '>&', '<>', '>|']);

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
    for (let i = 0; i < len;) {
        const cp = str.codePointAt(i);
        i += cp > 0xffff ? 2 : 1;
        out[count++] = normalizeCodePoint(cp, caseSensitive);
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

function hasBalancedBrackets(pattern) {
    let inClass = false;
    let classStart = 0;
    let memberCount = 0;

    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') {
            if (inClass) memberCount++;
            i++;
            continue;
        }
        if (c === '[') {
            if (inClass) return false;
            inClass = true;
            classStart = i;
            memberCount = 0;
        } else if (c === ']') {
            if (!inClass || memberCount === 0) return false;
            inClass = false;
        } else if (inClass) {
            if (i === classStart + 1 && (c === '!' || c === '^')) {
                continue;
            }
            memberCount++;
        }
    }
    return !inClass;
}

/**
 * Validates whether a glob pattern is syntactically well-formed and safe.
 *
 * @param {string} pattern - The glob pattern to validate.
 * @returns {boolean} True if the pattern is well-formed.
 */
export function isSafePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim() || Buffer.byteLength(pattern) > 512) {
        return false;
    }
    if (hasDanglingEscape(pattern)) {
        return false;
    }
    return hasBalancedBrackets(pattern);
}

function setAsciiBit(bits, cp) {
    bits[cp >>> 5] |= (1 << (cp & 31));
}

function addCodePointRange(min, max, asciiBits, unicodeRanges) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const asciiEnd = Math.min(hi, ASCII_LIMIT - 1);
    for (let cp = Math.max(0, lo); cp <= asciiEnd; cp++) {
        setAsciiBit(asciiBits, cp);
    }
    if (hi >= ASCII_LIMIT) {
        unicodeRanges.push(Math.max(ASCII_LIMIT, lo), hi);
    }
}

function addSingleCodePoint(cp, asciiBits, unicodeSet) {
    if (cp < ASCII_LIMIT) {
        setAsciiBit(asciiBits, cp);
    } else {
        unicodeSet.add(cp);
    }
}

function compileCharClass(content, caseSensitive) {
    const negated = content.startsWith('!') || content.startsWith('^');
    const raw = negated ? content.slice(1) : content;
    if (!raw) return () => false;
    const units = Array.from(raw);
    const asciiBits = new Uint32Array(4);
    const unicodeSet = new Set();
    const unicodeRanges = [];

    let i = 0;
    while (i < units.length) {
        if (units[i] === '\\' && i + 1 < units.length) {
            const cp = normalizeCodePoint(units[i + 1].codePointAt(0), caseSensitive);
            addSingleCodePoint(cp, asciiBits, unicodeSet);
            i += 2;
            continue;
        }
        if (i + 2 < units.length && units[i + 1] === '-' && units[i + 2] !== '\\') {
            const start = normalizeCodePoint(units[i].codePointAt(0), caseSensitive);
            const end = normalizeCodePoint(units[i + 2].codePointAt(0), caseSensitive);
            addCodePointRange(start, end, asciiBits, unicodeRanges);
            i += 3;
            continue;
        }
        const cp = normalizeCodePoint(units[i].codePointAt(0), caseSensitive);
        addSingleCodePoint(cp, asciiBits, unicodeSet);
        i++;
    }

    return (cp) => {
        let matched = false;
        if (cp < ASCII_LIMIT) {
            matched = (asciiBits[cp >>> 5] & (1 << (cp & 31))) !== 0;
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
    };
}

function findClosingBracket(chars, startIndex) {
    for (let j = startIndex; j < chars.length; j++) {
        if (chars[j] === '\\') {
            j++;
            continue;
        }
        if (chars[j] === ']') {
            return j;
        }
    }
    return -1;
}

function parseBracketToken(chars, i, caseSensitive) {
    const closeIdx = findClosingBracket(chars, i + 1);
    if (closeIdx === -1) {
        return {
            token: { type: TOK_CHAR, code: normalizeCodePoint(0x5b, caseSensitive) },
            nextIndex: i + 1
        };
    }
    const classContent = chars.slice(i + 1, closeIdx).join('');
    return {
        token: { type: TOK_CLASS, match: compileCharClass(classContent, caseSensitive) },
        nextIndex: closeIdx + 1
    };
}

function pushStar(tokens) {
    if (tokens.at(-1)?.type !== TOK_STAR) {
        tokens.push({ type: TOK_STAR });
    }
}

function parseTokens(pattern, caseSensitive) {
    const chars = Array.from(pattern);
    const tokens = [];
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === '\\') {
            i++;
            if (i < chars.length) {
                tokens.push({ type: TOK_CHAR, code: normalizeCodePoint(chars[i++].codePointAt(0), caseSensitive) });
            }
        } else if (c === '*') {
            pushStar(tokens);
            i++;
        } else if (c === '?') {
            tokens.push({ type: TOK_ANY });
            i++;
        } else if (c === '[') {
            const parsed = parseBracketToken(chars, i, caseSensitive);
            tokens.push(parsed.token);
            i = parsed.nextIndex;
        } else {
            tokens.push({ type: TOK_CHAR, code: normalizeCodePoint(c.codePointAt(0), caseSensitive) });
            i++;
        }
    }
    return tokens;
}

function matchesToken(tok, cp) {
    if (tok.type === TOK_ANY) return true;
    if (tok.type === TOK_CHAR) return tok.code === cp;
    return tok.match(cp);
}

/**
 * Deterministic linear-time glob matching with bit-level ASCII class lookup.
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

    const tokens = parseTokens(pattern, caseSensitive);
    const targetCodes = toCodePoints(text, caseSensitive);
    const stepBudget = maxSteps ?? Math.max(100000, targetCodes.length * 4);

    let pIdx = 0;
    let tIdx = 0;
    let starPIdx = -1;
    let starTIdx = -1;
    let steps = 0;

    while (tIdx < targetCodes.length) {
        if (++steps > stepBudget) {
            throw new StewardError('GLOB_COMPLEXITY', 'Glob evaluation exceeded execution step budget.');
        }

        if (pIdx < tokens.length) {
            const tok = tokens[pIdx];
            if (tok.type === TOK_STAR) {
                starPIdx = pIdx++;
                starTIdx = tIdx;
                continue;
            }
            if (matchesToken(tok, targetCodes[tIdx])) {
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

    while (pIdx < tokens.length && tokens[pIdx].type === TOK_STAR) {
        pIdx++;
    }

    return pIdx === tokens.length;
}

function flushArg(args, state) {
    if (state.hasToken || state.current.length > 0) {
        args.push(state.current);
        state.current = '';
        state.hasToken = false;
    }
}

function isWhitespaceChar(c, code) {
    return code < ASCII_LIMIT ? (CHAR_FLAGS[code] & FLAG_WS) !== 0 : /\s/.test(c);
}

function isOperatorCode(code) {
    return code < ASCII_LIMIT && (CHAR_FLAGS[code] & FLAG_OP) !== 0;
}

function isDoubleQuoteEscapable(code) {
    return code < ASCII_LIMIT && (CHAR_FLAGS[code] & FLAG_DBL_ESC) !== 0;
}

function consumeSingleQuoted(c, state) {
    if (c === "'") {
        state.quote = QUOTE_NONE;
    } else {
        state.current += c;
    }
}

function consumeDoubleQuoted(text, i, state) {
    const c = text[i];
    if (c === '"') {
        state.quote = QUOTE_NONE;
        return i + 1;
    }
    if (c === '\\' && i + 1 < text.length && isDoubleQuoteEscapable(text.charCodeAt(i + 1))) {
        state.current += text[i + 1];
        return i + 2;
    }
    state.current += c;
    return i + 1;
}

function consumeUnquotedOperator(text, i, args, state) {
    flushArg(args, state);
    if (i + 1 < text.length) {
        const pair = text.slice(i, i + 2);
        if (TWO_CHAR_OPS.has(pair)) {
            args.push(pair);
            return i + 2;
        }
    }
    args.push(text[i]);
    return i + 1;
}

/**
 * Tokenizes a command-line string following POSIX.1-2024 lexical rules:
 * - Single quotes preserve all characters literally (including backslashes).
 * - Double quotes allow escaping of ", \, $, `, and newline.
 * - Unquoted shell control and redirection operators delimit tokens.
 *
 * @param {string} text - Command line string.
 * @returns {string[]} Parsed arguments and operator tokens.
 */
export function tokenizeCommand(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const args = [];
    const state = { current: '', quote: QUOTE_NONE, hasToken: false };
    let i = 0;

    while (i < text.length) {
        const c = text[i];
        const code = text.charCodeAt(i);

        if (state.quote === QUOTE_SINGLE) {
            consumeSingleQuoted(c, state);
            i++;
            continue;
        }
        if (state.quote === QUOTE_DOUBLE) {
            i = consumeDoubleQuoted(text, i, state);
            continue;
        }
        if (c === '\\') {
            state.hasToken = true;
            if (i + 1 < text.length) {
                state.current += text[i + 1];
                i += 2;
            } else {
                state.current += '\\';
                i++;
            }
            continue;
        }
        if (c === "'") {
            state.quote = QUOTE_SINGLE;
            state.hasToken = true;
            i++;
            continue;
        }
        if (c === '"') {
            state.quote = QUOTE_DOUBLE;
            state.hasToken = true;
            i++;
            continue;
        }
        if (isWhitespaceChar(c, code)) {
            flushArg(args, state);
            i++;
            continue;
        }
        if (isOperatorCode(code)) {
            i = consumeUnquotedOperator(text, i, args, state);
            continue;
        }
        state.current += c;
        state.hasToken = true;
        i++;
    }

    flushArg(args, state);
    return args;
}

/**
 * Tests whether any glob pattern matches the target text as a whole,
 * or matches any individual argument token in a CLI command string.
 *
 * @param {string[]} patterns - Array of glob patterns.
 * @param {string} text - Target text or command string.
 * @param {object} [options] - Options for matching.
 * @returns {boolean} True if any pattern matches.
 */
export function matchArgGlob(patterns, text, options = {}) {
    if (!Array.isArray(patterns) || patterns.length === 0 || typeof text !== 'string') return false;
    for (const pat of patterns) {
        if (matchGlob(pat, text, options)) {
            return true;
        }
    }
    const tokens = tokenizeCommand(text);
    for (const tok of tokens) {
        for (const pat of patterns) {
            if (matchGlob(pat, tok, options)) {
                return true;
            }
        }
    }
    return false;
}
