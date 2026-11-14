// SPDX-License-Identifier: Apache-2.0

import { insist } from './errors.mjs';
import { isSafePattern, isSha256Hex, hasNonWhitespace, utf8Within } from './matcher.mjs';

export const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function object(x, keys, label) {
    insist(isObject(x), 'SCHEMA', `${label} must be an object.`);
    const isSet = keys instanceof Set;
    const ownKeys = Object.keys(x);
    for (let i = 0; i < ownKeys.length; i++) {
        const k = ownKeys[i];
        insist(isSet ? keys.has(k) : keys.includes(k), 'SCHEMA', `${label}: unknown field ${k}.`);
    }
}

export function text(x, label, max = 16000) {
    insist(typeof x === 'string' && hasNonWhitespace(x) && utf8Within(x, max), 'SCHEMA', `${label} must be a nonempty string of at most ${max} UTF-8 bytes.`);
}

export function strings(x, label, { empty = false, max = 100 } = {}) {
    const validLen = Array.isArray(x) && (empty || x.length > 0) && x.length <= max;
    insist(validLen, 'SCHEMA', `${label} must be ${empty ? 'an' : 'a nonempty'} array (at most ${max}).`);
    const len = x.length;
    for (let i = 0; i < len; i++) {
        text(x[i], label, 2048);
    }
    if (len === 2) {
        insist(x[0] !== x[1], 'SCHEMA', `${label} contains duplicates.`);
    } else if (len === 3) {
        insist(x[0] !== x[1] && x[0] !== x[2] && x[1] !== x[2], 'SCHEMA', `${label} contains duplicates.`);
    } else if (len >= 4) {
        insist(new Set(x).size === len, 'SCHEMA', `${label} contains duplicates.`);
    }
}

function integer(x, min, max, label) {
    insist(Number.isInteger(x) && x >= min && x <= max, 'SCHEMA', `${label} must be an integer in ${min}..${max}.`);
}

function hasDotSegment(v) {
    return v === '.' || v === '..' || v.startsWith('./') || v.startsWith('../') || v.endsWith('/.') || v.endsWith('/..') || v.includes('/./') || v.includes('/../');
}

function isRelativeLiteralPrefix(v) {
    if (v.startsWith('/') || v.includes('\\') || v.includes(':')) return false;
    return !hasDotSegment(v);
}

const MATCH_ARRAY_KEYS = ['tools', 'textAny', 'wordsAny', 'patternsAny', 'globsAny', 'pathPrefixes'];
const CONTENT_PREDICATE_KEYS = ['textAny', 'wordsAny', 'patternsAny', 'globsAny', 'pathPrefixes'];
const POLICY_KEYS = new Set(['version', 'budget', 'rules']);
const BUDGET_KEYS = new Set(['bytes', 'rules']);
const RULE_KEYS = new Set(['id', 'on', 'effect', 'priority', 'body', 'required', 'match']);
const RULE_MATCH_KEYS = new Set(['always', ...MATCH_ARRAY_KEYS]);
const PLAN_KEYS = new Set(['version', 'maxAgeSeconds', 'checks', 'exclude']);
const CHECK_KEYS = new Set(['id', 'description', 'argv', 'timeoutMs']);
const RULE_EVENT_SET = new Set(['prompt', 'tool', 'session', 'stop']);
const RULE_EFFECT_SET = new Set(['inject', 'deny']);

function validateMatchArrays(m) {
    for (let i = 0; i < MATCH_ARRAY_KEYS.length; i++) {
        const key = MATCH_ARRAY_KEYS[i];
        if (m[key] !== undefined) {
            strings(m[key], `match.${key}`);
        }
    }
    if (m.wordsAny) {
        for (let i = 0; i < m.wordsAny.length; i++) {
            insist(/[\p{L}\p{N}_-]/u.test(m.wordsAny[i]), 'SCHEMA', 'wordsAny must contain a searchable token.');
        }
    }
}

function validateMatchPatternsAndTools(m) {
    if (m.patternsAny) {
        for (let i = 0; i < m.patternsAny.length; i++) {
            insist(isSafePattern(m.patternsAny[i]), 'SCHEMA', 'patternsAny contains an unsafe or malformed pattern.');
        }
    }
    if (m.globsAny) {
        for (let i = 0; i < m.globsAny.length; i++) {
            insist(isSafePattern(m.globsAny[i]), 'SCHEMA', 'globsAny contains an unsafe or malformed pattern.');
        }
    }
    if (m.tools) {
        for (let i = 0; i < m.tools.length; i++) {
            insist(!m.tools[i].includes('*'), 'SCHEMA', 'Tool wildcards are not supported; omit tools to match all tools.');
        }
    }
    if (m.pathPrefixes) {
        for (let i = 0; i < m.pathPrefixes.length; i++) {
            const v = m.pathPrefixes[i];
            insist(isRelativeLiteralPrefix(v) && !v.includes('*'), 'SCHEMA', 'pathPrefixes must be project-relative literal paths.');
        }
    }
}

function validateRuleMatch(m, r) {
    object(m, RULE_MATCH_KEYS, 'rule.match');
    if (m.always !== undefined) {
        insist(m.always === true, 'SCHEMA', 'always, when provided, must be true.');
    }
    validateMatchArrays(m);
    validateMatchPatternsAndTools(m);
    let contentCount = 0;
    for (let i = 0; i < CONTENT_PREDICATE_KEYS.length; i++) {
        if (m[CONTENT_PREDICATE_KEYS[i]] !== undefined) contentCount++;
    }
    insist(m.always === true || contentCount > 0, 'SCHEMA', 'A match needs always:true or a content predicate.');
    insist(!(m.always && contentCount > 0), 'SCHEMA', 'always cannot be mixed with content predicates.');
    if (m.tools || m.pathPrefixes) {
        insist(r.on.length === 1 && r.on[0] === 'tool', 'SCHEMA', 'tools and pathPrefixes are tool-only.');
    }
}

function validatePolicyRule(r, ids) {
    object(r, RULE_KEYS, 'rule');
    text(r.id, 'rule.id', 80);
    insist(/^[a-z][a-z0-9-]*$/.test(r.id), 'SCHEMA', 'Rule IDs must be lowercase kebab-case.');
    insist(!ids.has(r.id), 'SCHEMA', `Duplicate rule ID: ${r.id}`);
    ids.add(r.id);
    strings(r.on, 'rule.on');
    for (let i = 0; i < r.on.length; i++) {
        insist(RULE_EVENT_SET.has(r.on[i]), 'SCHEMA', 'Unknown rule event.');
    }
    insist(RULE_EFFECT_SET.has(r.effect), 'SCHEMA', 'effect must be inject or deny.');
    text(r.body, 'rule.body');
    integer(r.priority, 0, 1000, 'rule.priority');
    insist(typeof r.required === 'boolean', 'SCHEMA', 'required must be boolean.');
    insist(!(r.effect === 'deny' && r.required), 'SCHEMA', 'Deny rules do not have a context budget; required must be false.');
    insist(!(r.effect === 'deny' && r.on.includes('session')), 'SCHEMA', 'Session rules can only inject.');
    validateRuleMatch(r.match, r);
}

export function validatePolicy(p) {
    object(p, POLICY_KEYS, 'policy');
    insist(p.version === 1, 'SCHEMA', 'Unsupported policy version.');
    object(p.budget, BUDGET_KEYS, 'budget');
    integer(p.budget.bytes, 128, 32768, 'budget.bytes');
    integer(p.budget.rules, 1, 64, 'budget.rules');
    insist(Array.isArray(p.rules) && p.rules.length <= 256, 'SCHEMA', 'rules must be an array of at most 256 entries.');
    const ids = new Set();
    for (let i = 0; i < p.rules.length; i++) {
        validatePolicyRule(p.rules[i], ids);
    }
    return p;
}

function validatePlanCheck(c, ids) {
    object(c, CHECK_KEYS, 'check');
    text(c.id, 'check.id', 80);
    text(c.description, 'check.description', 2048);
    insist(/^[a-z][a-z0-9-]*$/.test(c.id) && !ids.has(c.id), 'SCHEMA', 'Invalid or duplicate check ID.');
    ids.add(c.id);
    insist(Array.isArray(c.argv) && c.argv.length > 0 && c.argv.length <= 100, 'SCHEMA', 'check.argv must contain 1..100 strings.');
    for (let i = 0; i < c.argv.length; i++) {
        const a = c.argv[i];
        insist(typeof a === 'string' && utf8Within(a, 16384) && !a.includes('\0'), 'SCHEMA', 'Invalid command argument.');
    }
    text(c.argv[0], 'command', 4096);
    integer(c.timeoutMs, 50, 120000, 'timeoutMs');
}

export function validatePlan(p) {
    object(p, PLAN_KEYS, 'verification plan');
    insist(p.version === 1, 'SCHEMA', 'Unsupported plan version.');
    integer(p.maxAgeSeconds, 1, 604800, 'maxAgeSeconds');
    if (p.exclude !== undefined) {
        strings(p.exclude, 'plan.exclude', { empty: true, max: 32 });
        for (const v of p.exclude) {
            insist(isRelativeLiteralPrefix(v) && !/[*?[\]]/.test(v), 'SCHEMA', 'exclude must be project-relative literal path prefixes.');
        }
    }
    insist(Array.isArray(p.checks) && p.checks.length > 0 && p.checks.length <= 32, 'SCHEMA', 'Plan needs 1..32 checks.');
    const ids = new Set();
    for (const c of p.checks) {
        validatePlanCheck(c, ids);
    }
    insist(p.checks.reduce((n, c) => n + c.timeoutMs, 0) <= 600000, 'SCHEMA', 'Total timeout budget exceeds ten minutes.');
    return p;
}

export const RECORD_TYPES = ['decision', 'question', 'knowledge', 'goal', 'checkpoint', 'schedule', 'handoff'];

const ENTRY_FIELDS = {
    decision: ['statement', 'authority', 'supersedes', 'tags'],
    question: ['question', 'assumptions', 'resolution', 'supersedes', 'tags'],
    knowledge: ['claim', 'basis', 'sources', 'expiresAt', 'tags'],
    goal: ['objective', 'acceptance', 'status', 'evidence', 'tags'],
    checkpoint: ['summary', 'next', 'blockers', 'session', 'tags'],
    schedule: ['title', 'dueAt', 'status', 'members', 'id', 'supersedes', 'tags'],
    handoff: ['task', 'scope', 'constraints', 'acceptance', 'evidence', 'tags']
};

function validateSupersedes(value, message = 'supersedes must be null or a record hash.') {
    insist(value === null || isSha256Hex(value), 'SCHEMA', message);
}

function validateDecisionData(d) {
    text(d.statement, 'statement');
    object(d.authority, ['kind', 'reference', 'quote'], 'authority');
    insist(['user', 'delegated'].includes(d.authority.kind), 'SCHEMA', 'Decision needs attributed user or delegated authority.');
    text(d.authority.reference, 'authority.reference');
    text(d.authority.quote, 'authority.quote');
    validateSupersedes(d.supersedes);
}

function validateQuestionData(d) {
    text(d.question, 'question');
    strings(d.assumptions, 'assumptions', { empty: true });
    if (d.resolution !== null) text(d.resolution, 'resolution');
    validateSupersedes(d.supersedes);
}

function validateKnowledgeData(d) {
    text(d.claim, 'claim');
    insist(['source', 'observation', 'assumption'].includes(d.basis), 'SCHEMA', 'Invalid knowledge basis.');
    insist(Array.isArray(d.sources) && d.sources.length <= 64, 'SCHEMA', 'sources must be an array (at most 64).');
    for (const s of d.sources) {
        object(s, ['reference', 'checkedAt'], 'source');
        text(s.reference, 'source.reference');
        date(s.checkedAt, 'checkedAt');
    }
    insist(d.basis !== 'source' || d.sources.length > 0, 'SCHEMA', 'Source-based knowledge needs a source.');
    if (d.expiresAt !== null) {
        date(d.expiresAt, 'expiresAt');
    }
}

function validateGoalData(d) {
    text(d.objective, 'objective');
    strings(d.acceptance, 'acceptance');
    insist(['active', 'blocked', 'complete'].includes(d.status), 'SCHEMA', 'Invalid goal status.');
    strings(d.evidence, 'evidence', { empty: true });
    insist(d.status !== 'complete' || d.evidence.length > 0, 'SCHEMA', 'A completed goal needs evidence references.');
}

function validateCheckpointData(d) {
    if (d.session !== undefined && d.session !== null) {
        digest(d.session, 'checkpoint.session');
    }
    text(d.summary, 'summary', 1200);
    text(d.next, 'next', 800);
    strings(d.blockers, 'blockers', { empty: true, max: 8 });
    insist(Buffer.byteLength(JSON.stringify(d)) <= 4096, 'SCHEMA', 'Checkpoint exceeds 4096 bytes.');
}

function validateScheduleData(d) {
    if (d.id !== undefined) {
        insist(typeof d.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.id), 'SCHEMA', 'Invalid schedule identity.');
        validateSupersedes(d.supersedes, 'Schedule supersedes must be null or a record hash.');
    } else {
        insist(d.supersedes === undefined, 'SCHEMA', 'Schedule revisions require an identity.');
    }
    text(d.title, 'title');
    date(d.dueAt, 'dueAt');
    insist(['planned', 'staged', 'completed', 'cancelled'].includes(d.status), 'SCHEMA', 'Invalid schedule status.');
    strings(d.members, 'members', { empty: true });
}

function validateHandoffData(d) {
    text(d.task, 'task');
    strings(d.scope, 'scope');
    strings(d.constraints, 'constraints', { empty: true });
    strings(d.acceptance, 'acceptance');
    strings(d.evidence, 'evidence', { empty: true });
}

const ENTRY_VALIDATORS = {
    decision: validateDecisionData,
    question: validateQuestionData,
    knowledge: validateKnowledgeData,
    goal: validateGoalData,
    checkpoint: validateCheckpointData,
    schedule: validateScheduleData,
    handoff: validateHandoffData
};

export function validateEntry(entry) {
    object(entry, ['type', 'data'], 'entry');
    insist(RECORD_TYPES.includes(entry.type), 'SCHEMA', 'Unknown or reserved journal entry type.');
    const d = entry.data;
    object(d, ENTRY_FIELDS[entry.type], entry.type);
    if (d.tags !== undefined) {
        strings(d.tags, `${entry.type}.tags`, { empty: true, max: 16 });
    }
    ENTRY_VALIDATORS[entry.type](d);
    insist(Buffer.byteLength(JSON.stringify(entry)) <= 32768, 'SCHEMA', 'Journal entry exceeds 32 KiB.');
    return entry;
}

export function date(x, label) {
    text(x, label, 80);
    insist(/^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x)), 'SCHEMA', `${label} must be an ISO timestamp.`);
}

function digest(x, label) {
    insist(isSha256Hex(x), 'SCHEMA', `${label} must be a SHA-256 digest.`);
}

function uuid(x, label) {
    insist(typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x), 'SCHEMA', `${label} must be a UUID.`);
}

function validateVerificationCheck(c, runId, ids) {
    object(c, ['id', 'status', 'error', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr'], 'result');
    text(c.id, 'result.id', 80);
    insist(/^[a-z][a-z0-9-]*$/.test(c.id) && !ids.has(c.id), 'SCHEMA', 'Invalid or duplicate result ID.');
    ids.add(c.id);
    insist(['pass', 'fail', 'unavailable'].includes(c.status), 'SCHEMA', 'Invalid result status.');
    if (c.error !== null) text(c.error, 'result.error', 256);
    if (c.signal !== null) text(c.signal, 'result.signal', 256);
    insist(c.exitCode === null || Number.isInteger(c.exitCode), 'SCHEMA', 'Invalid exit code.');
    integer(c.durationMs, 0, Number.MAX_SAFE_INTEGER, 'durationMs');
    const validPass = c.error === null && c.exitCode === 0 && c.signal === null;
    insist(c.status !== 'pass' || validPass, 'SCHEMA', 'Passing result has a failure.');
    insist(c.status !== 'unavailable' || c.error === 'ENOENT', 'SCHEMA', 'Invalid unavailable result.');
    for (const stream of ['stdout', 'stderr']) {
        object(c[stream], ['path', 'sha256'], stream);
        insist(c[stream].path === `.steward/state/checks/${runId}/${c.id}.${stream}.txt`, 'SCHEMA', 'Output reference does not match its run and check.');
        digest(c[stream].sha256, `${stream}.sha256`);
    }
}

export function validateVerification(r) {
    object(r, ['version', 'runId', 'bundleHash', 'planHash', 'workspace', 'workspaceAfter', 'sourceUnchanged', 'runtime', 'checks', 'allPassed', 'limitations'], 'verification');
    insist(r.version === 1, 'SCHEMA', 'Unsupported verification version.');
    uuid(r.runId, 'runId');
    for (const key of ['bundleHash', 'planHash', 'workspaceAfter']) {
        digest(r[key], key);
    }
    object(r.workspace, ['hash', 'files', 'excluded'], 'workspace');
    digest(r.workspace.hash, 'workspace.hash');
    integer(r.workspace.files, 0, 20000, 'workspace.files');
    strings(r.workspace.excluded, 'workspace.excluded', { empty: true });
    insist(typeof r.sourceUnchanged === 'boolean' && r.sourceUnchanged === (r.workspace.hash === r.workspaceAfter), 'SCHEMA', 'Inconsistent source status.');
    object(r.runtime, ['node', 'platform', 'arch'], 'runtime');
    for (const key of ['node', 'platform', 'arch']) {
        text(r.runtime[key], `runtime.${key}`, 128);
    }
    insist(Array.isArray(r.checks) && r.checks.length > 0 && r.checks.length <= 32, 'SCHEMA', 'Invalid verification checks.');
    const ids = new Set();
    for (const c of r.checks) {
        validateVerificationCheck(c, r.runId, ids);
    }
    const expectedAllPassed = r.sourceUnchanged && r.checks.every(c => c.status === 'pass');
    insist(typeof r.allPassed === 'boolean' && r.allPassed === expectedAllPassed, 'SCHEMA', 'Inconsistent verification outcome.');
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
