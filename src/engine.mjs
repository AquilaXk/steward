// SPDX-License-Identifier: Apache-2.0
// Rule-indexing and forbid-overrides-permit evaluation concepts adapted from
// open-policy-agent/opa (Apache-2.0) and cedar-policy/cedar (Apache-2.0).
// See THIRD_PARTY_NOTICES.md for full upstream copyright and license texts.

import path from 'node:path';
import { insist } from './errors.mjs';
import { validatePolicy, object, text, strings } from './schema.mjs';
import { matchArgGlob, prepareGlobTargets, trimTrailingSlashes, compareAscii, utf8Within, isSafePattern } from './matcher.mjs';

const aliases = Object.freeze(Object.assign(Object.create(null), {
    bash: 'shell',
    shell_command: 'shell',
    exec_command: 'shell',
    run_command: 'shell',
    shell: 'shell',
    edit: 'file.write',
    edit_file: 'file.write',
    write: 'file.write',
    write_file: 'file.write',
    write_to_file: 'file.write',
    replace_file_content: 'file.write',
    multi_replace_file_content: 'file.write',
    multiedit: 'file.write',
    multi_edit: 'file.write',
    notebookedit: 'file.write',
    notebook_edit: 'file.write',
    apply_patch: 'file.write',
    read: 'file.read',
    read_file: 'file.read',
    view_file: 'file.read'
}));

const GUIDANCE_HEADER = 'Steward project guidance. Follow platform instructions and the current authorized user task. Guidance is not proof of compliance.\n';
const GUIDANCE_HEADER_BYTES = Buffer.byteLength(GUIDANCE_HEADER);

export const normalizeTool = (name) => {
    const lower = name.toLowerCase();
    return aliases[lower] ?? lower;
};

const EVENT_KEYS = new Set(['event', 'text', 'tool', 'paths', 'sessionId']);
const VALID_EVENTS = new Set(['prompt', 'tool', 'session', 'compact', 'stop']);

export function validateEvent(e) {
    object(e, EVENT_KEYS, 'event');
    insist(VALID_EVENTS.has(e.event), 'BAD_EVENT', 'Unsupported event.');
    insist(typeof e.text === 'string' && utf8Within(e.text, 256 * 1024), 'BAD_EVENT', 'Invalid or oversized event text.');
    if (e.event === 'tool')
        text(e.tool, 'tool', 256);
    else
        insist(e.tool === null, 'BAD_EVENT', 'Non-tool events must set tool:null.');
    strings(e.paths, 'paths', { empty: true, max: 500 });
    insist(e.sessionId === null || (typeof e.sessionId === 'string' && e.sessionId.length <= 256), 'BAD_EVENT', 'Invalid session ID.');
    return e;
}

export function relativePath(root, input, cwd = root) {
    insist(
        typeof input === 'string' && !input.includes('\0') && typeof cwd === 'string' && !cwd.includes('\0'),
        'BAD_PATH',
        'Path must not contain null bytes.'
    );
    const cleaned = input.replaceAll('\\', '/');
    // A foreign absolute Windows path cannot be mistaken for a project-relative one on POSIX.
    if (process.platform !== 'win32' && /^[a-z]:\//i.test(cleaned))
        return '@outside/' + cleaned;
    const p = path.relative(root, path.resolve(cwd, cleaned)).split(path.sep).join('/');
    if (p === '') return '.';
    return p === '..' || p.startsWith('../') ? '@outside/' + p : p;
}

function normalizeEventPath(rawPath) {
    insist(typeof rawPath === 'string' && !rawPath.includes('\0'), 'BAD_PATH', 'Path must not contain null bytes.');
    const cleaned = rawPath.replaceAll('\\', '/');
    if (cleaned.startsWith('@outside/')) {
        const sub = path.posix.normalize(cleaned.slice(9));
        const trimmed = sub.length > 1 && sub.endsWith('/') ? (trimTrailingSlashes(sub) || '/') : sub;
        return '@outside/' + trimmed;
    }
    let norm = path.posix.normalize(cleaned);
    if (norm === '..' || norm.startsWith('../')) {
        norm = norm.length > 1 && norm.endsWith('/') ? trimTrailingSlashes(norm) : norm;
        return '@outside/' + norm;
    }
    if (norm.length > 1 && norm.endsWith('/')) {
        norm = trimTrailingSlashes(norm) || '/';
    }
    return norm;
}

const WORD_ASCII_TABLE = (() => {
    const t = new Uint8Array(128);
    for (let c = 0x30; c <= 0x39; c++) t[c] = c;
    for (let c = 0x41; c <= 0x5a; c++) t[c] = c | 0x20;
    for (let c = 0x61; c <= 0x7a; c++) t[c] = c;
    t[0x5f] = 0x5f;
    t[0x2d] = 0x2d;
    return t;
})();

const WORD_CACHE_LIMIT = 512;
const wordCache = new Map();
const EMPTY_WORD_SET = Object.freeze(new Set());

function computeNormalizedWords(raw) {
    const len = raw.length;
    if (len === 0) return '';
    const chunks = [];
    let tokStart = -1;
    let hasUpper = false;
    for (let i = 0; i < len; i++) {
        const c = raw.charCodeAt(i);
        if (c >= 128) {
            const tokens = raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
            return tokens ? tokens.join(' ') : '';
        }
        const mapped = WORD_ASCII_TABLE[c];
        if (mapped !== 0) {
            if (tokStart === -1) {
                tokStart = i;
                hasUpper = mapped !== c;
            } else if (!hasUpper && mapped !== c) {
                hasUpper = true;
            }
        } else if (tokStart !== -1) {
            const tok = raw.slice(tokStart, i);
            chunks.push(hasUpper ? tok.toLowerCase() : tok);
            tokStart = -1;
        }
    }
    if (tokStart !== -1) {
        const tok = raw.slice(tokStart, len);
        chunks.push(hasUpper ? tok.toLowerCase() : tok);
    }
    return chunks.length === 0 ? '' : (chunks.length === 1 ? chunks[0] : chunks.join(' '));
}

function normalizedWords(raw) {
    if (raw.length <= 128) {
        const cached = wordCache.get(raw);
        if (cached !== undefined) return cached;
        const result = computeNormalizedWords(raw);
        if (wordCache.size >= WORD_CACHE_LIMIT) {
            wordCache.delete(wordCache.keys().next().value);
        }
        wordCache.set(raw, result);
        return result;
    }
    return computeNormalizedWords(raw);
}

function sameSnapshot(saved, current) {
    if (saved === null) return current === undefined;
    if (!Array.isArray(current) || saved.length !== current.length) return false;
    for (let i = 0; i < saved.length; i++) {
        if (saved[i] !== current[i]) return false;
    }
    return true;
}

const compiledRuleCache = new WeakMap();
const compiledPolicyCache = new WeakMap();

function isCompiledRuleFresh(cr, r) {
    const m = r.match;
    return (
        cr.id === r.id &&
        cr.effect === r.effect &&
        cr.body === r.body &&
        cr.required === r.required &&
        cr.priority === r.priority &&
        cr.matchRef === m &&
        cr.always === m.always &&
        cr.onRef === r.on &&
        sameSnapshot(cr.onSnap, r.on) &&
        cr.toolsRef === m.tools &&
        sameSnapshot(cr.toolsSnap, m.tools) &&
        cr.textAnyRef === m.textAny &&
        sameSnapshot(cr.textAnySnap, m.textAny) &&
        cr.wordsAnyRef === m.wordsAny &&
        sameSnapshot(cr.wordsAnySnap, m.wordsAny) &&
        cr.patternsAnyRef === m.patternsAny &&
        sameSnapshot(cr.patternsAnySnap, m.patternsAny) &&
        cr.globsAnyRef === m.globsAny &&
        sameSnapshot(cr.globsAnySnap, m.globsAny) &&
        cr.pathPrefixesRef === m.pathPrefixes &&
        sameSnapshot(cr.pathPrefixesSnap, m.pathPrefixes)
    );
}

function validateCompiledMatchPatterns(m) {
    if (m.patternsAny !== undefined) {
        insist(Array.isArray(m.patternsAny), 'SCHEMA', 'patternsAny must be an array.');
        for (let i = 0; i < m.patternsAny.length; i++) {
            insist(isSafePattern(m.patternsAny[i]), 'SCHEMA', 'Invalid glob pattern in patternsAny.');
        }
    }
    if (m.globsAny !== undefined) {
        insist(Array.isArray(m.globsAny), 'SCHEMA', 'globsAny must be an array.');
        for (let i = 0; i < m.globsAny.length; i++) {
            insist(isSafePattern(m.globsAny[i]), 'SCHEMA', 'Invalid glob pattern in globsAny.');
        }
    }
}

function compileRule(r) {
    const m = r.match;
    validateCompiledMatchPatterns(m);
    const toolSet = m.tools ? new Set(m.tools.map(t => normalizeTool(t))) : null;
    const lowerTextAny = m.textAny ? m.textAny.map(t => t.toLowerCase()) : null;
    let wordsSingle = null;
    let wordsPhrases = null;
    let hasWordsAny = false;
    if (m.wordsAny) {
        hasWordsAny = true;
        wordsSingle = [];
        wordsPhrases = [];
        for (let i = 0; i < m.wordsAny.length; i++) {
            const w = normalizedWords(m.wordsAny[i]);
            if (!w) continue;
            if (w.includes(' ')) wordsPhrases.push(' ' + w + ' ');
            else wordsSingle.push(w);
        }
    }
    const pathPrefixPairs = m.pathPrefixes
        ? m.pathPrefixes.map(p => {
            const base = trimTrailingSlashes(p).toLowerCase();
            return [base, base + '/'];
        })
        : null;
    const injectionLine = r.effect === 'inject' ? `[${r.id}] ${r.body}\n` : '';
    const injectionBytes = r.effect === 'inject' ? Buffer.byteLength(injectionLine) : 0;

    return {
        id: r.id,
        effect: r.effect,
        body: r.body,
        required: r.required,
        priority: r.priority,
        matchRef: m,
        always: m.always,
        onRef: r.on,
        onSnap: r.on.slice(),
        toolsRef: m.tools,
        toolsSnap: m.tools ? m.tools.slice() : null,
        textAnyRef: m.textAny,
        textAnySnap: m.textAny ? m.textAny.slice() : null,
        wordsAnyRef: m.wordsAny,
        wordsAnySnap: m.wordsAny ? m.wordsAny.slice() : null,
        patternsAnyRef: m.patternsAny,
        patternsAnySnap: m.patternsAny ? m.patternsAny.slice() : null,
        globsAnyRef: m.globsAny,
        globsAnySnap: m.globsAny ? m.globsAny.slice() : null,
        pathPrefixesRef: m.pathPrefixes,
        pathPrefixesSnap: m.pathPrefixes ? m.pathPrefixes.slice() : null,
        toolSet,
        lowerTextAny,
        hasWordsAny,
        wordsSingle,
        wordsPhrases,
        pathPrefixPairs,
        injectionLine,
        injectionBytes
    };
}

function getCompiledRule(r) {
    if (r === null || typeof r !== 'object' || !Array.isArray(r.on) || r.match === null || typeof r.match !== 'object') {
        return null;
    }
    const cached = compiledRuleCache.get(r);
    if (cached !== undefined && isCompiledRuleFresh(cached, r)) {
        return cached;
    }
    const compiled = compileRule(r);
    compiledRuleCache.set(r, compiled);
    return compiled;
}

function isRuleDeepFrozen(r) {
    if (!Object.isFrozen(r) || !Object.isFrozen(r.on) || !Object.isFrozen(r.match)) return false;
    const m = r.match;
    for (const k of ['tools', 'textAny', 'wordsAny', 'patternsAny', 'globsAny', 'pathPrefixes']) {
        if (m[k] !== undefined && !Object.isFrozen(m[k])) return false;
    }
    return true;
}

function isPolicyDeepFrozen(policy) {
    if (!Object.isFrozen(policy) || !Object.isFrozen(policy.budget) || !Object.isFrozen(policy.rules)) {
        return false;
    }
    for (let i = 0; i < policy.rules.length; i++) {
        if (!isRuleDeepFrozen(policy.rules[i])) return false;
    }
    return true;
}

function isCompiledPolicyFresh(cp, policy) {
    if (cp.allFrozen) return true;
    if (
        cp.version !== policy.version ||
        cp.budgetRef !== policy.budget ||
        cp.budgetBytes !== policy.budget?.bytes ||
        cp.budgetRules !== policy.budget?.rules ||
        cp.rulesRef !== policy.rules ||
        !Array.isArray(policy.rules) ||
        cp.rulesSnap.length !== policy.rules.length ||
        Object.keys(policy).length !== cp.rootKeyCount ||
        Object.keys(policy.budget).length !== cp.budgetKeyCount
    ) {
        return false;
    }
    for (let i = 0; i < policy.rules.length; i++) {
        const r = policy.rules[i];
        if (r !== cp.rulesSnap[i] || !isCompiledRuleFresh(cp.compiledRules[i], r)) {
            return false;
        }
    }
    return true;
}

function compareCompiledEntries(a, b) {
    const diff = b.priority - a.priority;
    return diff !== 0 ? diff : compareAscii(a.id, b.id);
}

function getCompiledPolicy(policy) {
    if (policy !== null && typeof policy === 'object') {
        const cached = compiledPolicyCache.get(policy);
        if (cached !== undefined && isCompiledPolicyFresh(cached, policy)) {
            return cached;
        }
    }
    validatePolicy(policy);
    const byEvent = {
        prompt: [],
        tool: [],
        session: [],
        compact: [],
        stop: []
    };
    const compiledRules = new Array(policy.rules.length);
    for (let i = 0; i < policy.rules.length; i++) {
        const r = policy.rules[i];
        const cr = getCompiledRule(r);
        compiledRules[i] = cr;
        for (let j = 0; j < r.on.length; j++) {
            const evName = r.on[j];
            if (byEvent[evName] !== undefined) {
                byEvent[evName].push(cr);
            }
        }
    }
    for (const evName of Object.keys(byEvent)) {
        if (byEvent[evName].length > 1) {
            byEvent[evName].sort(compareCompiledEntries);
        }
    }
    const entry = {
        allFrozen: isPolicyDeepFrozen(policy),
        version: policy.version,
        budgetRef: policy.budget,
        budgetBytes: policy.budget.bytes,
        budgetRules: policy.budget.rules,
        rootKeyCount: Object.keys(policy).length,
        budgetKeyCount: Object.keys(policy.budget).length,
        rulesRef: policy.rules,
        rulesSnap: policy.rules.slice(),
        compiledRules,
        byEvent
    };
    compiledPolicyCache.set(policy, entry);
    return entry;
}

function matchesPrecomputedPathPrefixes(prefixPairs, lowerPaths) {
    for (let i = 0; i < prefixPairs.length; i++) {
        const [base, dirPrefix] = prefixPairs[i];
        for (let j = 0; j < lowerPaths.length; j++) {
            const lp = lowerPaths[j];
            if (lp === base || lp.startsWith(dirPrefix)) return true;
        }
    }
    return false;
}

function prepareEventContext(event, precomputedWords = null) {
    const rawText = typeof event.text === 'string' ? event.text : '';
    const rawPaths = Array.isArray(event.paths) ? event.paths : [];
    let normalizedTool = null;
    let lowerText = null;
    let words = typeof precomputedWords === 'string' ? precomputedWords : null;
    let wordSet = null;
    let paddedWords = null;
    let lowerPaths = null;
    let globTargets = null;
    return {
        getNormalizedTool() {
            if (normalizedTool === null) {
                normalizedTool = event.tool ? normalizeTool(event.tool) : '';
            }
            return normalizedTool;
        },
        getLowerText() {
            if (lowerText === null) {
                lowerText = rawText.toLowerCase();
            }
            return lowerText;
        },
        getWords() {
            if (words === null) {
                words = normalizedWords(rawText);
            }
            return words;
        },
        getWordSet() {
            if (wordSet === null) {
                const w = this.getWords();
                wordSet = w ? new Set(w.split(' ')) : EMPTY_WORD_SET;
            }
            return wordSet;
        },
        getPaddedWords() {
            if (paddedWords === null) {
                paddedWords = ' ' + this.getWords() + ' ';
            }
            return paddedWords;
        },
        getLowerPaths() {
            if (lowerPaths === null) {
                lowerPaths = rawPaths.map(p => normalizeEventPath(p).toLowerCase());
            }
            return lowerPaths;
        },
        getGlobTargets() {
            if (globTargets === null) {
                globTargets = prepareGlobTargets(rawText, false);
            }
            return globTargets;
        }
    };
}

function matchesCompiledPredicates(cr, e, ctx) {
    if (cr.toolSet !== null) {
        if (!cr.toolSet.has(ctx.getNormalizedTool())) return false;
    }
    if (cr.always) return true;
    if (cr.lowerTextAny !== null) {
        const lowerText = ctx.getLowerText();
        const needles = cr.lowerTextAny;
        let hit = false;
        for (let i = 0; i < needles.length; i++) {
            if (lowerText.includes(needles[i])) {
                hit = true;
                break;
            }
        }
        if (!hit) return false;
    }
    if (cr.hasWordsAny) {
        let hit = false;
        const single = cr.wordsSingle;
        if (single.length > 0) {
            const wSet = ctx.getWordSet();
            for (let i = 0; i < single.length; i++) {
                if (wSet.has(single[i])) {
                    hit = true;
                    break;
                }
            }
        }
        if (!hit && cr.wordsPhrases.length > 0) {
            const haystack = ctx.getPaddedWords();
            const phrases = cr.wordsPhrases;
            for (let i = 0; i < phrases.length; i++) {
                if (haystack.includes(phrases[i])) {
                    hit = true;
                    break;
                }
            }
        }
        if (!hit) return false;
    }
    const m = cr.matchRef;
    const rawText = typeof e.text === 'string' ? e.text : '';
    if (m.patternsAny && !matchArgGlob(m.patternsAny, rawText, { preparedTargets: ctx.getGlobTargets() })) {
        return false;
    }
    if (m.globsAny && !matchArgGlob(m.globsAny, rawText, { preparedTargets: ctx.getGlobTargets() })) {
        return false;
    }
    if (cr.pathPrefixPairs !== null && !matchesPrecomputedPathPrefixes(cr.pathPrefixPairs, ctx.getLowerPaths())) {
        return false;
    }
    return true;
}

export function matches(r, e, words = null) {
    if (!e || typeof e !== 'object' || typeof e.event !== 'string') {
        return false;
    }
    const on = r?.on;
    if (!Array.isArray(on) || (on.length === 1 ? on[0] !== e.event : !on.includes(e.event))) {
        return false;
    }
    const cr = getCompiledRule(r);
    if (cr === null) return false;
    const ctx = (words !== null && typeof words === 'object')
        ? words
        : prepareEventContext(e, words);
    return matchesCompiledPredicates(cr, e, ctx);
}

export function evaluate(policy, event) {
    const compiledPolicy = getCompiledPolicy(policy);
    validateEvent(event);
    const ctx = prepareEventContext(event);

    const bucket = compiledPolicy.byEvent[event.event];
    const matchedIds = [];
    const deniedEntries = [];
    const requiredInjects = [];
    const optionalInjects = [];

    if (bucket !== undefined) {
        for (let i = 0; i < bucket.length; i++) {
            const cr = bucket[i];
            if (matchesCompiledPredicates(cr, event, ctx)) {
                matchedIds.push(cr.id);
                if (cr.effect === 'deny') {
                    deniedEntries.push(cr);
                } else if (cr.effect === 'inject') {
                    if (cr.required) requiredInjects.push(cr);
                    else optionalInjects.push(cr);
                }
            }
        }
    }

    const base = { decision: 'allow', reason: null, matched: matchedIds, emitted: [], omitted: [], context: '', bytes: 0 };
    if (deniedEntries.length > 0) {
        return {
            ...base,
            decision: 'deny',
            reason: `Policy ${deniedEntries[0].id}: ${deniedEntries[0].body}`,
            denied: deniedEntries.map(r => r.id)
        };
    }

    const emitted = [];
    const omitted = [];
    const missingRequired = [];
    const emittedChunks = [];
    let currentBytes = 0;
    const maxRules = policy.budget.rules;
    const maxBytes = policy.budget.bytes;

    for (let i = 0; i < requiredInjects.length; i++) {
        const cr = requiredInjects[i];
        if (emitted.length >= maxRules) {
            omitted.push({ id: cr.id, reason: 'rule_limit' });
            missingRequired.push(cr.id);
            continue;
        }
        const nextBytes = (currentBytes === 0 ? GUIDANCE_HEADER_BYTES : currentBytes) + cr.injectionBytes;
        if (nextBytes > maxBytes) {
            omitted.push({ id: cr.id, reason: 'byte_budget' });
            missingRequired.push(cr.id);
            continue;
        }
        if (currentBytes === 0) {
            emittedChunks.push(GUIDANCE_HEADER);
        }
        emittedChunks.push(cr.injectionLine);
        currentBytes = nextBytes;
        emitted.push(cr.id);
    }

    for (let i = 0; i < optionalInjects.length; i++) {
        const cr = optionalInjects[i];
        if (emitted.length >= maxRules) {
            omitted.push({ id: cr.id, reason: 'rule_limit' });
            continue;
        }
        const nextBytes = (currentBytes === 0 ? GUIDANCE_HEADER_BYTES : currentBytes) + cr.injectionBytes;
        if (nextBytes > maxBytes) {
            omitted.push({ id: cr.id, reason: 'byte_budget' });
            continue;
        }
        if (currentBytes === 0) {
            emittedChunks.push(GUIDANCE_HEADER);
        }
        emittedChunks.push(cr.injectionLine);
        currentBytes = nextBytes;
        emitted.push(cr.id);
    }

    if (missingRequired.length > 0) {
        return {
            ...base,
            decision: 'deny',
            reason: `Required guidance exceeds the configured context budget: ${missingRequired.join(', ')}.`,
            omitted
        };
    }

    const context = emittedChunks.join('');
    return { ...base, emitted, omitted, context, bytes: currentBytes };
}
