import path from 'node:path';
import { insist } from './errors.mjs';
import { validatePolicy, object, text, strings } from './schema.mjs';
const aliases = { bash: 'shell', shell_command: 'shell', exec_command: 'shell', shell: 'shell', edit: 'file.write', write: 'file.write', apply_patch: 'file.write', read: 'file.read', read_file: 'file.read' };
export const normalizeTool = (name) => aliases[name.toLowerCase()] || name.toLowerCase();
export function validateEvent(e) {
    object(e, ['event', 'text', 'tool', 'paths', 'sessionId'], 'event');
    insist(['prompt', 'tool', 'session', 'compact'].includes(e.event), 'BAD_EVENT', 'Unsupported event.');
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
function normalizedWords(raw) { return (raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).join(' '); }
function wordMatch(term, normalized) { const needle = normalizedWords(term); return !!needle && (' ' + normalized + ' ').includes(' ' + needle + ' '); }
export function matches(r, e, words = null) {
    if (!r.on.includes(e.event))
        return false;
    const m = r.match;
    if (m.tools && !m.tools.some(t => normalizeTool(t) === normalizeTool(e.tool || '')))
        return false;
    if (m.always)
        return true;
    if (m.textAny && !m.textAny.some(t => e.text.toLowerCase().includes(t.toLowerCase())))
        return false;
    if (m.wordsAny && !m.wordsAny.some(t => wordMatch(t, words ?? normalizedWords(e.text))))
        return false;
    if (m.pathPrefixes && !m.pathPrefixes.some(prefix => e.paths.some(p => p === prefix.replace(/\/$/, '') || p.startsWith(prefix.replace(/\/$/, '') + '/'))))
        return false;
    return true;
}
export function evaluate(policy, event) {
    validatePolicy(policy);
    validateEvent(event);
    const words = normalizedWords(event.text);
    const matched = policy.rules.filter(r => matches(r, event, words)).sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
        const reason = emitted.length >= policy.budget.rules ? 'rule_limit' : Buffer.byteLength(candidate) > policy.budget.bytes ? 'byte_budget' : null;
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
