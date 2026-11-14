// SPDX-License-Identifier: Apache-2.0
// Rule-indexing and forbid-overrides-permit evaluation concepts adapted from
// open-policy-agent/opa (Apache-2.0) and cedar-policy/cedar (Apache-2.0).
// See THIRD_PARTY_NOTICES.md for full upstream copyright and license texts.

import path from 'node:path';
import { insist } from './errors.mjs';
import { validatePolicy, object, text, strings } from './schema.mjs';
import { matchArgGlob, prepareGlobTargets, trimTrailingSlashes, compareAscii, utf8Within } from './matcher.mjs';

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
    const cleaned = input.replaceAll('\\', '/');
    // A foreign absolute Windows path cannot be mistaken for a project-relative one on POSIX.
    if (process.platform !== 'win32' && /^[a-z]:\//i.test(cleaned))
        return '@outside/' + cleaned;
    const p = path.relative(root, path.resolve(cwd, cleaned)).split(path.sep).join('/');
    return p === '..' || p.startsWith('../') ? '@outside/' + p : p;
}

const WORD_CACHE_LIMIT = 512;
const wordCache = new Map();

function normalizedWords(raw) {
    if (raw.length <= 128) {
        const cached = wordCache.get(raw);
        if (cached !== undefined) return cached;
        const tokens = raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
        const result = tokens ? tokens.join(' ') : '';
        if (wordCache.size >= WORD_CACHE_LIMIT) {
            wordCache.clear();
        }
        wordCache.set(raw, result);
        return result;
    }
    const tokens = raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
    return tokens ? tokens.join(' ') : '';
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

function compileRule(r) {
    const m = r.match;
    const toolSet = m.tools ? new Set(m.tools.map(t => normalizeTool(t))) : null;
    const lowerTextAny = m.textAny ? m.textAny.map(t => t.toLowerCase()) : null;
    const wordsNeedles = m.wordsAny ? m.wordsAny.map(t => normalizedWords(t)).filter(Boolean) : null;
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
        wordsNeedles,
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
    let normalizedTool = null;
    let lowerText = null;
    let words = typeof precomputedWords === 'string' ? precomputedWords : null;
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
                lowerText = event.text.toLowerCase();
            }
            return lowerText;
        },
        getPaddedWords() {
            if (paddedWords === null) {
                if (words === null) words = normalizedWords(event.text);
                paddedWords = ' ' + words + ' ';
            }
            return paddedWords;
        },
        getLowerPaths() {
            if (lowerPaths === null) {
                lowerPaths = event.paths.map(p => p.toLowerCase());
            }
            return lowerPaths;
        },
        getGlobTargets() {
            if (globTargets === null) {
                globTargets = prepareGlobTargets(event.text, false);
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
    if (cr.wordsNeedles !== null) {
        const needles = cr.wordsNeedles;
        if (needles.length === 0) return false;
        const haystack = ctx.getPaddedWords();
        let hit = false;
        for (let i = 0; i < needles.length; i++) {
            if (haystack.includes(' ' + needles[i] + ' ')) {
                hit = true;
                break;
            }
        }
        if (!hit) return false;
    }
    const m = cr.matchRef;
    if (m.patternsAny && !matchArgGlob(m.patternsAny, e.text, { preparedTargets: ctx.getGlobTargets() })) {
        return false;
    }
    if (m.globsAny && !matchArgGlob(m.globsAny, e.text, { preparedTargets: ctx.getGlobTargets() })) {
        return false;
    }
    if (cr.pathPrefixPairs !== null && !matchesPrecomputedPathPrefixes(cr.pathPrefixPairs, ctx.getLowerPaths())) {
        return false;
    }
    return true;
}

export function matches(r, e, words = null) {
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

function compareMatchedEntries(a, b) {
    const diff = b.rule.priority - a.rule.priority;
    return diff !== 0 ? diff : compareAscii(a.rule.id, b.rule.id);
}

export function evaluate(policy, event) {
    validatePolicy(policy);
    validateEvent(event);
    const ctx = prepareEventContext(event);

    const matchedEntries = [];
    for (let i = 0; i < policy.rules.length; i++) {
        const r = policy.rules[i];
        const on = r.on;
        if (on.length === 1 ? on[0] !== event.event : !on.includes(event.event)) continue;
        const cr = getCompiledRule(r);
        if (matchesCompiledPredicates(cr, event, ctx)) {
            matchedEntries.push({ rule: r, compiled: cr });
        }
    }

    matchedEntries.sort(compareMatchedEntries);

    const matchedIds = [];
    const deniedEntries = [];
    const requiredInjects = [];
    const optionalInjects = [];

    for (let i = 0; i < matchedEntries.length; i++) {
        const entry = matchedEntries[i];
        const r = entry.rule;
        matchedIds.push(r.id);
        if (r.effect === 'deny') {
            deniedEntries.push(r);
        } else if (r.effect === 'inject') {
            if (r.required) requiredInjects.push(entry);
            else optionalInjects.push(entry);
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

    // Required guidance gets the first budget allocation, then stable priority order.
    const orderedInjects = requiredInjects.length > 0
        ? requiredInjects.concat(optionalInjects)
        : optionalInjects;
    const emitted = [];
    const omitted = [];
    const emittedChunks = [];
    let currentBytes = 0;

    for (let i = 0; i < orderedInjects.length; i++) {
        const { rule: r, compiled: cr } = orderedInjects[i];
        if (emitted.length >= policy.budget.rules) {
            omitted.push({ id: r.id, reason: 'rule_limit' });
            continue;
        }
        const nextBytes = (currentBytes === 0 ? GUIDANCE_HEADER_BYTES : currentBytes) + cr.injectionBytes;
        if (nextBytes > policy.budget.bytes) {
            omitted.push({ id: r.id, reason: 'byte_budget' });
            continue;
        }
        if (currentBytes === 0) {
            emittedChunks.push(GUIDANCE_HEADER);
        }
        emittedChunks.push(cr.injectionLine);
        currentBytes = nextBytes;
        emitted.push(r.id);
    }

    const emittedSet = new Set(emitted);
    const missing = requiredInjects.filter(e => !emittedSet.has(e.rule.id)).map(e => e.rule.id);
    if (missing.length > 0) {
        return {
            ...base,
            decision: 'deny',
            reason: `Required guidance exceeds the configured context budget: ${missing.join(', ')}.`,
            omitted
        };
    }

    const context = emittedChunks.join('');
    return { ...base, emitted, omitted, context, bytes: currentBytes };
}
