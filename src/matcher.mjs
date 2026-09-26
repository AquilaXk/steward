import { insist } from './errors.mjs';

/**
 * Validates whether a glob pattern is syntactically well-formed and safe.
 * Ensures balanced brackets and bounded length to prevent syntax anomalies.
 *
 * @param {string} pattern - The glob pattern to validate.
 * @returns {boolean} True if the pattern is well-formed.
 */
export function isSafePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim() || Buffer.byteLength(pattern) > 512) {
        return false;
    }
    // Reject odd number of trailing backslashes (dangling escape)
    let trailingBackslashes = 0;
    for (let i = pattern.length - 1; i >= 0 && pattern[i] === '\\'; i--) {
        trailingBackslashes++;
    }
    if (trailingBackslashes % 2 !== 0) {
        return false;
    }

    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') {
            i++; // skip escaped character
            continue;
        }
        if (c === '[') {
            if (inClass) return false; // nested classes disallowed
            inClass = true;
        } else if (c === ']') {
            if (!inClass) return false; // unmatched closing bracket
            inClass = false;
        }
    }
    return !inClass;
}

/**
 * Compiles a character class into a matcher predicate.
 * Supports exact characters, ranges (a-z, 0-9), negation ([!...] or [^...]),
 * and full Unicode code points with proper escaping (\-, \], \\).
 */
function compileCharClass(content, caseSensitive) {
    let negated = false;
    let chars = content;
    if (chars.startsWith('!') || chars.startsWith('^')) {
        negated = true;
        chars = chars.slice(1);
    }

    const codeUnits = Array.from(chars);
    const elements = [];
    let i = 0;
    while (i < codeUnits.length) {
        let ch = codeUnits[i];
        if (ch === '\\' && i + 1 < codeUnits.length) {
            i++;
            ch = codeUnits[i];
            elements.push({ type: 'char', value: caseSensitive ? ch : ch.toLowerCase() });
            i++;
            continue;
        }
        if (i + 2 < codeUnits.length && codeUnits[i + 1] === '-' && codeUnits[i + 2] !== '\\') {
            const start = (caseSensitive ? ch : ch.toLowerCase()).codePointAt(0);
            const endCh = caseSensitive ? codeUnits[i + 2] : codeUnits[i + 2].toLowerCase();
            const end = endCh.codePointAt(0);
            elements.push({ type: 'range', min: Math.min(start, end), max: Math.max(start, end) });
            i += 3;
            continue;
        }
        elements.push({ type: 'char', value: caseSensitive ? ch : ch.toLowerCase() });
        i++;
    }

    return (ch) => {
        const c = caseSensitive ? ch : ch.toLowerCase();
        const code = c.codePointAt(0);
        let matched = false;
        for (const el of elements) {
            if (el.type === 'char' && el.value === c) {
                matched = true;
                break;
            } else if (el.type === 'range' && code >= el.min && code <= el.max) {
                matched = true;
                break;
            }
        }
        return negated ? !matched : matched;
    };
}

/**
 * Parses a glob pattern into a linear list of match tokens:
 * - { type: 'star' }
 * - { type: 'any' } (? wildcard matching 1 Unicode code point)
 * - { type: 'char', char } (literal char)
 * - { type: 'class', match } (compiled character class)
 */
function parseTokens(pattern, caseSensitive) {
    const chars = Array.from(pattern);
    const tokens = [];
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === '\\') {
            i++;
            if (i < chars.length) {
                tokens.push({ type: 'char', char: caseSensitive ? chars[i] : chars[i].toLowerCase() });
                i++;
            }
        } else if (c === '*') {
            // Collapse multiple consecutive stars into a single star
            if (tokens.length === 0 || tokens[tokens.length - 1].type !== 'star') {
                tokens.push({ type: 'star' });
            }
            i++;
        } else if (c === '?') {
            tokens.push({ type: 'any' });
            i++;
        } else if (c === '[') {
            let closeIdx = -1;
            let j = i + 1;
            while (j < chars.length) {
                if (chars[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (chars[j] === ']') {
                    closeIdx = j;
                    break;
                }
                j++;
            }
            if (closeIdx === -1) {
                // Malformed bracket, treat as literal
                tokens.push({ type: 'char', char: '[' });
                i++;
            } else {
                const classContent = chars.slice(i + 1, closeIdx).join('');
                tokens.push({ type: 'class', match: compileCharClass(classContent, caseSensitive) });
                i = closeIdx + 1;
            }
        } else {
            tokens.push({ type: 'char', char: caseSensitive ? c : c.toLowerCase() });
            i++;
        }
    }
    return tokens;
}

/**
 * Deterministic linear-time glob matching.
 * Guarantees O(N * M) worst-case time complexity without exponential backtracking (ReDoS safe).
 * Includes an execution step budget to prevent excessive resource consumption.
 *
 * @param {string} pattern - Glob pattern (*, ?, [...], \).
 * @param {string} text - Candidate string to match against.
 * @param {object} [options] - Options.
 * @param {boolean} [options.caseSensitive=false] - Whether matching is case-sensitive.
 * @param {number} [options.maxSteps=100000] - Hard execution step limit.
 * @returns {boolean} True if text matches pattern.
 */
export function matchGlob(pattern, text, { caseSensitive = false, maxSteps = 100000 } = {}) {
    if (typeof pattern !== 'string' || typeof text !== 'string') return false;
    if (pattern === '*') return true;
    if (pattern === text) return true;

    const tokens = parseTokens(pattern, caseSensitive);
    const targetChars = Array.from(caseSensitive ? text : text.toLowerCase());

    let pIdx = 0;
    let tIdx = 0;
    let starPIdx = -1;
    let starTIdx = -1;
    let steps = 0;

    while (tIdx < targetChars.length) {
        if (++steps > maxSteps) {
            // Exceeded execution budget; fail-closed
            return false;
        }

        if (pIdx < tokens.length) {
            const tok = tokens[pIdx];
            if (tok.type === 'star') {
                starPIdx = pIdx;
                starTIdx = tIdx;
                pIdx++;
                continue;
            }
            if (tok.type === 'any' || (tok.type === 'char' && tok.char === targetChars[tIdx]) || (tok.type === 'class' && tok.match(targetChars[tIdx]))) {
                pIdx++;
                tIdx++;
                continue;
            }
        }

        // Mismatch: backtrack to the most recent star if available
        if (starPIdx !== -1) {
            pIdx = starPIdx + 1;
            starTIdx++;
            tIdx = starTIdx;
            continue;
        }

        return false;
    }

    // Consume any trailing stars
    while (pIdx < tokens.length && tokens[pIdx].type === 'star') {
        pIdx++;
    }

    return pIdx === tokens.length;
}

/**
 * Safely tokenizes a command-line string into distinct argument tokens without shell evaluation.
 * Handles double and single quotes cleanly, preserving empty quoted arguments.
 *
 * @param {string} text - Command line string.
 * @returns {string[]} Parsed arguments.
 */
export function tokenizeCommand(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const args = [];
    let current = '';
    let inQuotes = null;
    let escaped = false;
    let hasToken = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escaped) {
            current += c;
            hasToken = true;
            escaped = false;
        } else if (c === '\\') {
            escaped = true;
            hasToken = true;
        } else if (inQuotes) {
            if (c === inQuotes) {
                inQuotes = null;
            } else {
                current += c;
            }
        } else if (c === '"' || c === "'") {
            inQuotes = c;
            hasToken = true;
        } else if (/\s/.test(c)) {
            if (hasToken || current.length > 0) {
                args.push(current);
                current = '';
                hasToken = false;
            }
        } else {
            current += c;
            hasToken = true;
        }
    }
    if (hasToken || current.length > 0) {
        args.push(current);
    }
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
