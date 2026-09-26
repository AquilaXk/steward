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
 * Supports exact characters, ranges (a-z, 0-9), and negation ([!...] or [^...]).
 */
function compileCharClass(content, caseSensitive) {
    let negated = false;
    let chars = content;
    if (chars.startsWith('!') || chars.startsWith('^')) {
        negated = true;
        chars = chars.slice(1);
    }
    const targetChars = caseSensitive ? chars : chars.toLowerCase();

    return (ch) => {
        const c = caseSensitive ? ch : ch.toLowerCase();
        let matched = false;
        let i = 0;
        while (i < targetChars.length) {
            if (i + 2 < targetChars.length && targetChars[i + 1] === '-') {
                const start = targetChars.charCodeAt(i);
                const end = targetChars.charCodeAt(i + 2);
                const code = c.charCodeAt(0);
                if (code >= Math.min(start, end) && code <= Math.max(start, end)) {
                    matched = true;
                    break;
                }
                i += 3;
            } else {
                if (c === targetChars[i]) {
                    matched = true;
                    break;
                }
                i++;
            }
        }
        return negated ? !matched : matched;
    };
}

/**
 * Parses a glob pattern into a linear list of match tokens:
 * - { type: 'star' }
 * - { type: 'any' } (? wildcard)
 * - { type: 'char', char } (literal char)
 * - { type: 'class', match } (compiled character class)
 */
function parseTokens(pattern, caseSensitive) {
    const tokens = [];
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '\\') {
            i++;
            if (i < pattern.length) {
                tokens.push({ type: 'char', char: caseSensitive ? pattern[i] : pattern[i].toLowerCase() });
            }
            i++;
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
            const closeIdx = pattern.indexOf(']', i + 1);
            if (closeIdx === -1) {
                // Malformed bracket, treat as literal
                tokens.push({ type: 'char', char: caseSensitive ? '[' : '[' });
                i++;
            } else {
                const classContent = pattern.slice(i + 1, closeIdx);
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
    const target = caseSensitive ? text : text.toLowerCase();

    let pIdx = 0;
    let tIdx = 0;
    let starPIdx = -1;
    let starTIdx = -1;
    let steps = 0;

    while (tIdx < target.length) {
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
            if (tok.type === 'any' || (tok.type === 'char' && tok.char === target[tIdx]) || (tok.type === 'class' && tok.match(target[tIdx]))) {
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
 * Handles double and single quotes cleanly.
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

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escaped) {
            current += c;
            escaped = false;
        } else if (c === '\\') {
            escaped = true;
        } else if (inQuotes) {
            if (c === inQuotes) {
                inQuotes = null;
            } else {
                current += c;
            }
        } else if (c === '"' || c === "'") {
            inQuotes = c;
        } else if (/\s/.test(c)) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
        } else {
            current += c;
        }
    }
    if (current.length > 0) {
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
