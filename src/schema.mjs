import { insist } from './errors.mjs';
export const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function object(x, keys, label) {
    insist(isObject(x), 'SCHEMA', `${label} must be an object.`);
    for (const k of Object.keys(x))
        insist(keys.includes(k), 'SCHEMA', `${label}: unknown field ${k}.`);
}
export function text(x, label, max = 16000) { insist(typeof x === 'string' && x.trim() && Buffer.byteLength(x) <= max, 'SCHEMA', `${label} must be a nonempty string of at most ${max} UTF-8 bytes.`); }
export function strings(x, label, { empty = false, max = 100 } = {}) {
    insist(Array.isArray(x) && (empty || x.length > 0) && x.length <= max, 'SCHEMA', `${label} must be ${empty ? 'an' : 'a nonempty'} array (at most ${max}).`);
    x.forEach((v) => text(v, label, 2048));
    insist(new Set(x).size === x.length, 'SCHEMA', `${label} contains duplicates.`);
}
function integer(x, min, max, label) { insist(Number.isInteger(x) && x >= min && x <= max, 'SCHEMA', `${label} must be an integer in ${min}..${max}.`); }
export function validatePolicy(p) {
    object(p, ['version', 'budget', 'rules'], 'policy');
    insist(p.version === 1, 'SCHEMA', 'Unsupported policy version.');
    object(p.budget, ['bytes', 'rules'], 'budget');
    integer(p.budget.bytes, 128, 32768, 'budget.bytes');
    integer(p.budget.rules, 1, 64, 'budget.rules');
    insist(Array.isArray(p.rules) && p.rules.length <= 256, 'SCHEMA', 'rules must be an array of at most 256 entries.');
    const ids = new Set();
    for (const r of p.rules) {
        object(r, ['id', 'on', 'effect', 'priority', 'body', 'required', 'match'], 'rule');
        text(r.id, 'rule.id', 80);
        insist(/^[a-z][a-z0-9-]*$/.test(r.id), 'SCHEMA', 'Rule IDs must be lowercase kebab-case.');
        insist(!ids.has(r.id), 'SCHEMA', `Duplicate rule ID: ${r.id}`);
        ids.add(r.id);
        strings(r.on, 'rule.on');
        insist(r.on.every(e => ['prompt', 'tool', 'session'].includes(e)), 'SCHEMA', 'Unknown rule event.');
        insist(['inject', 'deny'].includes(r.effect), 'SCHEMA', 'effect must be inject or deny.');
        text(r.body, 'rule.body');
        integer(r.priority, 0, 1000, 'rule.priority');
        insist(typeof r.required === 'boolean', 'SCHEMA', 'required must be boolean.');
        insist(!(r.effect === 'deny' && r.required), 'SCHEMA', 'Deny rules do not have a context budget; required must be false.');
        insist(!(r.effect === 'deny' && r.on.includes('session')), 'SCHEMA', 'Session rules can only inject.');
        const m = r.match;
        object(m, ['always', 'tools', 'textAny', 'wordsAny', 'pathPrefixes'], 'rule.match');
        if (m.always !== undefined)
            insist(m.always === true, 'SCHEMA', 'always, when provided, must be true.');
        for (const key of ['tools', 'textAny', 'wordsAny', 'pathPrefixes'])
            if (m[key] !== undefined)
                strings(m[key], `match.${key}`);
        if (m.wordsAny)
            for (const term of m.wordsAny)
                insist(/[\p{L}\p{N}_-]/u.test(term), 'SCHEMA', 'wordsAny must contain a searchable token.');
        if (m.tools)
            for (const tool of m.tools)
                insist(!tool.includes('*'), 'SCHEMA', 'Tool wildcards are not supported; omit tools to match all tools.');
        const content = ['textAny', 'wordsAny', 'pathPrefixes'].filter(k => m[k] !== undefined);
        insist(m.always === true || content.length > 0, 'SCHEMA', 'A match needs always:true or a content predicate.');
        insist(!(m.always && content.length), 'SCHEMA', 'always cannot be mixed with content predicates.');
        if (m.tools || m.pathPrefixes)
            insist(r.on.length === 1 && r.on[0] === 'tool', 'SCHEMA', 'tools and pathPrefixes are tool-only.');
        if (m.pathPrefixes)
            for (const v of m.pathPrefixes)
                insist(!v.startsWith('/') && !v.includes('\\') && !v.split('/').some(s => s === '..' || s === '.') && !v.includes('*') && !v.includes(':'), 'SCHEMA', 'pathPrefixes must be project-relative literal paths.');
    }
    return p;
}
export function validatePlan(p) {
    object(p, ['version', 'maxAgeSeconds', 'checks'], 'verification plan');
    insist(p.version === 1, 'SCHEMA', 'Unsupported plan version.');
    integer(p.maxAgeSeconds, 1, 604800, 'maxAgeSeconds');
    insist(Array.isArray(p.checks) && p.checks.length > 0 && p.checks.length <= 32, 'SCHEMA', 'Plan needs 1..32 checks.');
    const ids = new Set();
    for (const c of p.checks) {
        object(c, ['id', 'description', 'argv', 'timeoutMs'], 'check');
        text(c.id, 'check.id', 80);
        text(c.description, 'check.description', 2048);
        insist(/^[a-z][a-z0-9-]*$/.test(c.id) && !ids.has(c.id), 'SCHEMA', 'Invalid or duplicate check ID.');
        ids.add(c.id);
        insist(Array.isArray(c.argv) && c.argv.length > 0 && c.argv.length <= 100, 'SCHEMA', 'check.argv must contain 1..100 strings.');
        c.argv.forEach(a => insist(typeof a === 'string' && Buffer.byteLength(a) <= 16384 && !a.includes('\0'), 'SCHEMA', 'Invalid command argument.'));
        text(c.argv[0], 'command', 4096);
        integer(c.timeoutMs, 50, 120000, 'timeoutMs');
    }
    insist(p.checks.reduce((n, c) => n + c.timeoutMs, 0) <= 600000, 'SCHEMA', 'Total timeout budget exceeds ten minutes.');
    return p;
}
export const RECORD_TYPES = ['decision', 'question', 'knowledge', 'goal', 'checkpoint', 'schedule', 'handoff'];
export function validateEntry(entry) {
    object(entry, ['type', 'data'], 'entry');
    insist(RECORD_TYPES.includes(entry.type), 'SCHEMA', 'Unknown or reserved journal entry type.');
    const d = entry.data;
    const fields = { decision: ['statement', 'authority', 'supersedes'], question: ['question', 'assumptions', 'resolution', 'supersedes'], knowledge: ['claim', 'basis', 'sources', 'expiresAt'], goal: ['objective', 'acceptance', 'status', 'evidence'], checkpoint: ['summary', 'next', 'blockers', 'session'], schedule: ['title', 'dueAt', 'status', 'members', 'id', 'supersedes'], handoff: ['task', 'scope', 'constraints', 'acceptance', 'evidence'] };
    object(d, fields[entry.type], entry.type);
    if (entry.type === 'decision') {
        text(d.statement, 'statement');
        object(d.authority, ['kind', 'reference', 'quote'], 'authority');
        insist(['user', 'delegated'].includes(d.authority.kind), 'SCHEMA', 'Decision needs attributed user or delegated authority.');
        text(d.authority.reference, 'authority.reference');
        text(d.authority.quote, 'authority.quote');
    }
    if (['decision', 'question'].includes(entry.type))
        insist(d.supersedes === null || (typeof d.supersedes === 'string' && /^[a-f0-9]{64}$/.test(d.supersedes)), 'SCHEMA', 'supersedes must be null or a record hash.');
    if (entry.type === 'question') {
        text(d.question, 'question');
        strings(d.assumptions, 'assumptions', { empty: true });
        insist(d.resolution === null || typeof d.resolution === 'string', 'SCHEMA', 'resolution must be null or text.');
    }
    if (entry.type === 'knowledge') {
        text(d.claim, 'claim');
        insist(['source', 'observation', 'assumption'].includes(d.basis), 'SCHEMA', 'Invalid knowledge basis.');
        insist(Array.isArray(d.sources), 'SCHEMA', 'sources must be an array.');
        for (const s of d.sources) {
            object(s, ['reference', 'checkedAt'], 'source');
            text(s.reference, 'source.reference');
            date(s.checkedAt, 'checkedAt');
        }
        insist(d.basis !== 'source' || d.sources.length > 0, 'SCHEMA', 'Source-based knowledge needs a source.');
        if (d.expiresAt !== null)
            date(d.expiresAt, 'expiresAt');
    }
    if (entry.type === 'goal') {
        text(d.objective, 'objective');
        strings(d.acceptance, 'acceptance');
        insist(['active', 'blocked', 'complete'].includes(d.status), 'SCHEMA', 'Invalid goal status.');
        strings(d.evidence, 'evidence', { empty: true });
        insist(d.status !== 'complete' || d.evidence.length > 0, 'SCHEMA', 'A completed goal needs evidence references.');
    }
    if (entry.type === 'checkpoint') {
        if (d.session !== undefined && d.session !== null)
            digest(d.session, 'checkpoint.session');
        text(d.summary, 'summary', 1200);
        text(d.next, 'next', 800);
        strings(d.blockers, 'blockers', { empty: true, max: 8 });
        insist(Buffer.byteLength(JSON.stringify(d)) <= 4096, 'SCHEMA', 'Checkpoint exceeds 4096 bytes.');
    }
    if (entry.type === 'schedule') {
        if (d.id !== undefined) {
            insist(typeof d.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.id), 'SCHEMA', 'Invalid schedule identity.');
            insist(d.supersedes === null || (typeof d.supersedes === 'string' && /^[a-f0-9]{64}$/.test(d.supersedes)), 'SCHEMA', 'Schedule supersedes must be null or a record hash.');
        } else insist(d.supersedes === undefined, 'SCHEMA', 'Schedule revisions require an identity.');
        text(d.title, 'title');
        date(d.dueAt, 'dueAt');
        insist(['planned', 'staged', 'completed', 'cancelled'].includes(d.status), 'SCHEMA', 'Invalid schedule status.');
        strings(d.members, 'members', { empty: true });
    }
    if (entry.type === 'handoff') {
        text(d.task, 'task');
        strings(d.scope, 'scope');
        strings(d.constraints, 'constraints', { empty: true });
        strings(d.acceptance, 'acceptance');
        strings(d.evidence, 'evidence', { empty: true });
    }
    insist(Buffer.byteLength(JSON.stringify(entry)) <= 32768, 'SCHEMA', 'Journal entry exceeds 32 KiB.');
    return entry;
}
export function date(x, label) { text(x, label, 80); insist(/^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x)), 'SCHEMA', `${label} must be an ISO timestamp.`); }

function digest(x, label) { insist(typeof x === 'string' && /^[a-f0-9]{64}$/.test(x), 'SCHEMA', `${label} must be a SHA-256 digest.`); }
function uuid(x, label) { insist(typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x), 'SCHEMA', `${label} must be a UUID.`); }
export function validateVerification(r) {
    object(r, ['version', 'runId', 'bundleHash', 'planHash', 'workspace', 'workspaceAfter', 'sourceUnchanged', 'runtime', 'checks', 'allPassed', 'limitations'], 'verification');
    insist(r.version === 1, 'SCHEMA', 'Unsupported verification version.');
    uuid(r.runId, 'runId');
    for (const key of ['bundleHash', 'planHash', 'workspaceAfter']) digest(r[key], key);
    object(r.workspace, ['hash', 'files', 'excluded'], 'workspace');
    digest(r.workspace.hash, 'workspace.hash');
    integer(r.workspace.files, 0, 20000, 'workspace.files');
    strings(r.workspace.excluded, 'workspace.excluded', { empty: true });
    insist(typeof r.sourceUnchanged === 'boolean' && r.sourceUnchanged === (r.workspace.hash === r.workspaceAfter), 'SCHEMA', 'Inconsistent source status.');
    object(r.runtime, ['node', 'platform', 'arch'], 'runtime');
    for (const key of ['node', 'platform', 'arch']) text(r.runtime[key], `runtime.${key}`, 128);
    insist(Array.isArray(r.checks) && r.checks.length > 0 && r.checks.length <= 32, 'SCHEMA', 'Invalid verification checks.');
    const ids = new Set();
    for (const c of r.checks) {
        object(c, ['id', 'status', 'error', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr'], 'result');
        text(c.id, 'result.id', 80);
        insist(/^[a-z][a-z0-9-]*$/.test(c.id) && !ids.has(c.id), 'SCHEMA', 'Invalid or duplicate result ID.');
        ids.add(c.id);
        insist(['pass', 'fail', 'unavailable'].includes(c.status), 'SCHEMA', 'Invalid result status.');
        for (const key of ['error', 'signal']) if (c[key] !== null) text(c[key], `result.${key}`, 256);
        insist(c.exitCode === null || Number.isInteger(c.exitCode), 'SCHEMA', 'Invalid exit code.');
        integer(c.durationMs, 0, Number.MAX_SAFE_INTEGER, 'durationMs');
        insist(c.status !== 'pass' || (c.error === null && c.exitCode === 0 && c.signal === null), 'SCHEMA', 'Passing result has a failure.');
        insist(c.status !== 'unavailable' || c.error === 'ENOENT', 'SCHEMA', 'Invalid unavailable result.');
        for (const stream of ['stdout', 'stderr']) {
            object(c[stream], ['path', 'sha256'], stream);
            insist(c[stream].path === `.steward/state/checks/${r.runId}/${c.id}.${stream}.txt`, 'SCHEMA', 'Output reference does not match its run and check.');
            digest(c[stream].sha256, `${stream}.sha256`);
        }
    }
    insist(typeof r.allPassed === 'boolean' && r.allPassed === (r.sourceUnchanged && r.checks.every(c => c.status === 'pass')), 'SCHEMA', 'Inconsistent verification outcome.');
    strings(r.limitations, 'limitations', { empty: true });
    return r;
}
export function validateJournalRow(row) {
    object(row, ['version', 'seq', 'id', 'type', 'time', 'previous', 'data', 'hash'], 'journal record');
    insist(row.version === 1, 'SCHEMA', 'Unsupported journal version.');
    integer(row.seq, 1, 99999999, 'seq');
    uuid(row.id, 'id');
    date(row.time, 'time');
    if (row.previous !== null) digest(row.previous, 'previous');
    digest(row.hash, 'hash');
    if (row.type === 'verification') validateVerification(row.data);
    else validateEntry({ type: row.type, data: row.data });
    return row;
}
