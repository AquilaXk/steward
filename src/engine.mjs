import path from 'node:path';
import { insist } from './errors.mjs';
import { validatePolicy, object, text, strings } from './schema.mjs';
import { matchArgGlob, prepareGlobTargets, trimTrailingSlashes, compareAscii } from './matcher.mjs';
const aliases = {
    bash: 'shell',
    shell_command: 'shell',
    exec_command: 'shell',
    run_command: 'shell',
    shell: 'shell',
    edit: 'file.write',
    write: 'file.write',
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
};
export const normalizeTool = (name) => {
    const lower = name.toLowerCase();
    return Object.hasOwn(aliases, lower) ? aliases[lower] : lower;
};
export function validateEvent(e) {
    object(e, ['event', 'text', 'tool', 'paths', 'sessionId'], 'event');
    insist(['prompt', 'tool', 'session', 'compact', 'stop'].includes(e.event), 'BAD_EVENT', 'Unsupported event.');
    insist(typeof e.text === 'string' && Buffer.byteLength(e.text) <= 256 * 1024, 'BAD_EVENT', 'Invalid or oversized event text.');
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
function wordMatch(term, normalized) {
    const needle = normalizedWords(term);
    if (!needle) return false;
    return (' ' + normalized + ' ').includes(' ' + needle + ' ');
}
function matchesPathPrefixes(prefixes, lowerPaths) {
    for (const rawPrefix of prefixes) {
        const base = trimTrailingSlashes(rawPrefix).toLowerCase();
        const dirPrefix = base + '/';
        const matched = lowerPaths.some(lp => lp === base || lp.startsWith(dirPrefix));
        if (matched) return true;
    }
    return false;
}
function prepareEventContext(event, precomputedWords = null) {
    let normalizedTool = null;
    let lowerText = null;
    let words = typeof precomputedWords === 'string' ? precomputedWords : null;
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
        getWords() {
            if (words === null) {
                words = normalizedWords(event.text);
            }
            return words;
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
export function matches(r, e, words = null) {
    if (!r.on.includes(e.event))
        return false;
    const ctx = (words !== null && typeof words === 'object')
        ? words
        : prepareEventContext(e, words);
    const m = r.match;
    if (m.tools) {
        const eventTool = ctx.getNormalizedTool();
        if (!m.tools.some(t => normalizeTool(t) === eventTool))
            return false;
    }
    if (m.always)
        return true;
    if (m.textAny) {
        const lowerText = ctx.getLowerText();
        if (!m.textAny.some(t => lowerText.includes(t.toLowerCase())))
            return false;
    }
    if (m.wordsAny) {
        const eventWords = ctx.getWords();
        if (!m.wordsAny.some(t => wordMatch(t, eventWords)))
            return false;
    }
    if (m.patternsAny && !matchArgGlob(m.patternsAny, e.text, { preparedTargets: ctx.getGlobTargets() }))
        return false;
    if (m.globsAny && !matchArgGlob(m.globsAny, e.text, { preparedTargets: ctx.getGlobTargets() }))
        return false;
    if (m.pathPrefixes && !matchesPathPrefixes(m.pathPrefixes, ctx.getLowerPaths()))
        return false;
    return true;
}
function compareMatchedRules(a, b) {
    const diff = b.priority - a.priority;
    return diff !== 0 ? diff : compareAscii(a.id, b.id);
}
function budgetOmissionReason(emittedCount, candidate, budget) {
    if (emittedCount >= budget.rules) return 'rule_limit';
    if (Buffer.byteLength(candidate) > budget.bytes) return 'byte_budget';
    return null;
}
export function evaluate(policy, event) {
    validatePolicy(policy);
    validateEvent(event);
    const ctx = prepareEventContext(event);
    const matched = policy.rules.filter(r => matches(r, event, ctx)).sort(compareMatchedRules);
    const denied = matched.filter(r => r.effect === 'deny');
    const base = { decision: 'allow', reason: null, matched: matched.map(r => r.id), emitted: [], omitted: [], context: '', bytes: 0 };
    if (denied.length)
        return { ...base, decision: 'deny', reason: `Policy ${denied[0].id}: ${denied[0].body}`, denied: denied.map(r => r.id) };
    const header = 'Steward project guidance. Follow platform instructions and the current authorized user task. Guidance is not proof of compliance.\n';
    let context = '';
    const emitted = [], omitted = [];
    // Required guidance gets the first budget allocation, then stable priority order.
    const injections = matched.filter(r => r.effect === 'inject').sort((a, b) => Number(b.required) - Number(a.required));
    for (const r of injections) {
        const line = `[${r.id}] ${r.body}\n`;
        const candidate = (context || header) + line;
        const reason = budgetOmissionReason(emitted.length, candidate, policy.budget);
        if (reason) {
            omitted.push({ id: r.id, reason });
            continue;
        }
        context = candidate;
        emitted.push(r.id);
    }
    const missing = injections.filter(r => r.required && !emitted.includes(r.id));
    if (missing.length)
        return { ...base, decision: 'deny', reason: `Required guidance exceeds the configured context budget: ${missing.map(r => r.id).join(', ')}.`, omitted };
    return { ...base, emitted, omitted, context, bytes: Buffer.byteLength(context) };
}
