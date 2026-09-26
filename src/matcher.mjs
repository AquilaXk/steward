/**
 * Validates whether a glob pattern is syntactically well-formed and safe.
 * Ensures balanced brackets and bounded length to prevent syntax anomalies.
 *
 * @param {string} pattern - The glob pattern to validate.
 * @returns {boolean} True if the pattern is well-formed.
 */
function hasDanglingEscape(pattern) {
    let trailingBackslashes = 0;
    for (let i = pattern.length - 1; i >= 0 && pattern[i] === '\\'; i--) {
        trailingBackslashes++;
    }
    return trailingBackslashes % 2 !== 0;
}

function hasBalancedBrackets(pattern) {
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

export function isSafePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim() || Buffer.byteLength(pattern) > 512) {
        return false;
    }
    if (hasDanglingEscape(pattern)) {
        return false;
    }
    return hasBalancedBrackets(pattern);
}

/**
 * Parses raw code points from inside a character class into character and range elements.
 */
function tryParseRangeElement(codeUnits, i, norm) {
    if (i + 2 < codeUnits.length && codeUnits[i + 1] === '-' && codeUnits[i + 2] !== '\\') {
        const start = norm(codeUnits[i]).codePointAt(0);
        const end = norm(codeUnits[i + 2]).codePointAt(0);
        return {
            element: { type: 'range', min: Math.min(start, end), max: Math.max(start, end) },
            step: 3
        };
    }
    return null;
}

function parseCharClassElements(codeUnits, caseSensitive) {
    const elements = [];
    const norm = (ch) => (caseSensitive ? ch : ch.toLowerCase());
    let i = 0;
    while (i < codeUnits.length) {
        if (codeUnits[i] === '\\' && i + 1 < codeUnits.length) {
            elements.push({ type: 'char', value: norm(codeUnits[i + 1]) });
            i += 2;
            continue;
        }
        const rangeMatch = tryParseRangeElement(codeUnits, i, norm);
        if (rangeMatch) {
            elements.push(rangeMatch.element);
            i += rangeMatch.step;
            continue;
        }
        elements.push({ type: 'char', value: norm(codeUnits[i]) });
        i++;
    }
    return elements;
}

/**
 * Compiles a character class into a matcher predicate.
 * Supports exact characters, ranges (a-z, 0-9), negation ([!...] or [^...]),
 * and full Unicode code points with proper escaping (\-, \], \\).
 */
function compileCharClass(content, caseSensitive) {
    const negated = content.startsWith('!') || content.startsWith('^');
    const chars = negated ? content.slice(1) : content;
    const elements = parseCharClassElements(Array.from(chars), caseSensitive);

    return (ch) => {
        const c = caseSensitive ? ch : ch.toLowerCase();
        const code = c.codePointAt(0);
        const matched = elements.some(el =>
            el.type === 'char' ? el.value === c : (code >= el.min && code <= el.max)
        );
        return negated ? !matched : matched;
    };
}

/**
 * Finds the index of an unescaped closing bracket ']' in an array of characters.
 */
function findClosingBracket(chars, startIndex) {
    let j = startIndex;
    while (j < chars.length) {
        if (chars[j] === '\\') {
            j += 2;
            continue;
        }
        if (chars[j] === ']') {
            return j;
        }
        j++;
    }
    return -1;
}

/**
 * Parses a glob pattern into a linear list of match tokens:
 * - { type: 'star' }
 * - { type: 'any' } (? wildcard matching 1 Unicode code point)
 * - { type: 'char', char } (literal char)
 * - { type: 'class', match } (compiled character class)
 */
function parseBracketToken(chars, i, caseSensitive) {
    const closeIdx = findClosingBracket(chars, i + 1);
    if (closeIdx === -1) {
        return { token: { type: 'char', char: '[' }, nextIndex: i + 1 };
    }
    const classContent = chars.slice(i + 1, closeIdx).join('');
    return {
        token: { type: 'class', match: compileCharClass(classContent, caseSensitive) },
        nextIndex: closeIdx + 1
    };
}

function pushStar(tokens) {
    if (tokens.at(-1)?.type !== 'star') {
        tokens.push({ type: 'star' });
    }
}

function parseTokens(pattern, caseSensitive) {
    const chars = Array.from(pattern);
    const tokens = [];
    const norm = (ch) => (caseSensitive ? ch : ch.toLowerCase());
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === '\\') {
            i++;
            if (i < chars.length) {
                tokens.push({ type: 'char', char: norm(chars[i++]) });
            }
        } else if (c === '*') {
            pushStar(tokens);
            i++;
        } else if (c === '?') {
            tokens.push({ type: 'any' });
            i++;
        } else if (c === '[') {
            const parsed = parseBracketToken(chars, i, caseSensitive);
            tokens.push(parsed.token);
            i = parsed.nextIndex;
        } else {
            tokens.push({ type: 'char', char: norm(c) });
            i++;
        }
    }
    return tokens;
}

/**
 * Tests whether a match token satisfies a specific character.
 */
function matchesToken(tok, char) {
    if (tok.type === 'any') return true;
    if (tok.type === 'char') return tok.char === char;
    if (tok.type === 'class') return tok.match(char);
    return false;
}

/**
 * Evaluates the next step for a single token match attempt.
 *
 * @param {Array<object>} tokens
 * @param {Array<string>} targetChars
 * @param {number} pIdx
 * @param {number} tIdx
 * @returns {'star' | 'advance' | 'mismatch'}
 */
function matchStep(tokens, targetChars, pIdx, tIdx) {
    if (pIdx >= tokens.length) return 'mismatch';
    const tok = tokens[pIdx];
    if (tok.type === 'star') return 'star';
    return matchesToken(tok, targetChars[tIdx]) ? 'advance' : 'mismatch';
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

        const action = matchStep(tokens, targetChars, pIdx, tIdx);
        if (action === 'star') {
            starPIdx = pIdx++;
            starTIdx = tIdx;
            continue;
        }
        if (action === 'advance') {
            pIdx++;
            tIdx++;
            continue;
        }

        // Mismatch: backtrack to the most recent star if available
        if (starPIdx !== -1) {
            pIdx = starPIdx + 1;
            tIdx = ++starTIdx;
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
function flushArg(args, state) {
    if (state.hasToken || state.current.length > 0) {
        args.push(state.current);
        state.current = '';
        state.hasToken = false;
    }
}

function handleInQuotes(c, state) {
    if (c === state.inQuotes) {
        state.inQuotes = null;
    } else {
        state.current += c;
    }
}

export function tokenizeCommand(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const args = [];
    const state = { current: '', inQuotes: null, escaped: false, hasToken: false };

    for (const c of text) {
        if (state.escaped) {
            state.current += c;
            state.hasToken = true;
            state.escaped = false;
            continue;
        }
        if (c === '\\') {
            state.escaped = true;
            state.hasToken = true;
            continue;
        }
        if (state.inQuotes) {
            handleInQuotes(c, state);
            continue;
        }
        if (c === '"' || c === "'") {
            state.inQuotes = c;
            state.hasToken = true;
            continue;
        }
        if (/\s/.test(c)) {
            flushArg(args, state);
            continue;
        }
        state.current += c;
        state.hasToken = true;
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
