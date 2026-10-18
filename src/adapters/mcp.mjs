import path from 'node:path';
import { rootOf, sha256 } from '../fs.mjs';
import { VERSION } from '../version.mjs';
import { evaluate } from '../engine.mjs';
import { normalizeInput } from '../adapters.mjs';
import { requireTrust } from '../trust.mjs';
import { appendEntry, readJournal, journalHead, queryJournal, latestCheckpoint } from '../journal.mjs';
import { runVerification, completionGate } from '../verify.mjs';
import { doctor } from '../doctor.mjs';
import { PACKAGE_ROOT } from '../setup.mjs';
import { insist, publicError } from '../errors.mjs';
import { object } from '../schema.mjs';

const MAX_LINE_BYTES = 1024 * 1024;
const PROJECT_PROP = {
    type: 'string',
    description: 'Optional target project directory path; defaults to the server startup project root.'
};

/**
 * 11 Core Steward MCP Tools definition.
 */
export const STEWARD_TOOLS = [
    {
        name: 'steward_policy_eval',
        description: 'Evaluate an action event against trusted project policy. Returns allow/deny, matched rules, and injected context guidance.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                event: { type: 'string', enum: ['prompt', 'tool', 'session'], description: 'The event type to evaluate.' },
                text: { type: 'string', description: 'The prompt text, command string, or description.' },
                tool: { type: 'string', description: 'Tool name if event is "tool" (e.g., shell, file.write).' },
                paths: { type: 'array', items: { type: 'string' }, description: 'Project paths accessed by the tool.' },
                sessionId: { type: 'string', description: 'Optional session identifier.' }
            },
            required: ['event', 'text'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_recall',
        description: 'Query journal records (decisions, questions, knowledge, goals, checkpoints, schedules, handoffs, verifications) with filtering and freshness checks.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                type: { type: 'string', enum: ['decision', 'question', 'knowledge', 'goal', 'checkpoint', 'schedule', 'handoff', 'verification'] },
                text: { type: 'string', description: 'Search text within journal records.' },
                tag: { type: 'string', description: 'Filter by tag.' },
                since: { type: 'string', description: 'Filter records created on or after ISO timestamp.' },
                until: { type: 'string', description: 'Filter records created on or before ISO timestamp.' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                history: { type: 'boolean', default: false, description: 'Include superseded and expired records.' },
                recordId: { type: 'string', description: 'Filter by specific record ID.' },
                sessionId: { type: 'string', description: 'Filter checkpoints by session ID.' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'steward_record_decision',
        description: 'Record an explicitly confirmed architectural or design decision in the immutable, verifiable journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                statement: { type: 'string', description: 'The decision statement.' },
                authority: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: ['user', 'delegated'] },
                        reference: { type: 'string', description: 'Source reference (issue, conversation, PR).' },
                        quote: { type: 'string', description: 'Exact authorizing quote.' }
                    },
                    required: ['kind', 'reference', 'quote'],
                    additionalProperties: false
                },
                supersedes: { type: 'string', description: 'SHA-256 hash of a prior decision record being replaced, or null.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['statement', 'authority'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_checkpoint',
        description: 'Persist session progress summary, next actions, and blockers into the journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                summary: { type: 'string', description: 'Concise summary of progress made so far.' },
                next: { type: 'string', description: 'Concrete next action to execute.' },
                blockers: { type: 'array', items: { type: 'string' }, description: 'Any blocking issues or open questions.' },
                sessionId: { type: 'string', description: 'Optional session identifier to bind checkpoint restoration.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['summary', 'next'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_verify',
        description: 'Run the project approved verification plan commands and capture cryptographic evidence of test outcomes.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP
            },
            additionalProperties: false
        }
    },
    {
        name: 'steward_completion_gate',
        description: 'Verify whether the latest recorded evidence satisfies the verification plan and unchanged source snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                evidence: { type: 'string', description: 'Optional specific verification evidence SHA-256 hash.' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'steward_record_knowledge',
        description: 'Record verified domain knowledge, conventions, or constraints into the immutable journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                claim: { type: 'string', description: 'The verified assertion or domain fact.' },
                basis: { type: 'string', enum: ['source', 'observation', 'assumption'] },
                sources: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            reference: { type: 'string' },
                            checkedAt: { type: 'string', description: 'ISO timestamp.' }
                        },
                        required: ['reference', 'checkedAt'],
                        additionalProperties: false
                    }
                },
                expiresAt: { type: 'string', description: 'Optional ISO timestamp after which this knowledge expires.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['claim', 'basis'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_schedule_manage',
        description: 'Create or revise a milestone schedule in the project journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                title: { type: 'string', description: 'Milestone or task title.' },
                dueAt: { type: 'string', description: 'Due date as ISO timestamp.' },
                status: { type: 'string', enum: ['planned', 'staged', 'completed', 'cancelled'] },
                members: { type: 'array', items: { type: 'string' }, description: 'Responsible agents or users.' },
                id: { type: 'string', description: 'Optional stable identifier for schedule tracking.' },
                supersedes: { type: ['string', 'null'], description: 'Optional SHA-256 hash of previous schedule version being replaced, or null.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['title', 'dueAt', 'status'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_goal_manage',
        description: 'Record or update a durable work goal with acceptance criteria and verification evidence references in the journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                objective: { type: 'string', description: 'Clear statement of the work goal objective.' },
                acceptance: { type: 'array', items: { type: 'string' }, description: 'Concrete acceptance criteria (nonempty).' },
                status: { type: 'string', enum: ['active', 'blocked', 'complete'], description: 'Current lifecycle status of the goal.' },
                evidence: { type: 'array', items: { type: 'string' }, description: 'Verification evidence hashes or references (required when status is complete).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['objective', 'acceptance', 'status'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_record_handoff',
        description: 'Record a bounded subagent delegation or session handoff contract with explicit file scope and acceptance criteria.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                task: { type: 'string', description: 'Specific delegated task or handoff objective.' },
                scope: { type: 'array', items: { type: 'string' }, description: 'Explicit allowed file or directory scope (nonempty).' },
                constraints: { type: 'array', items: { type: 'string' }, description: 'Explicit boundary constraints or forbidden files.' },
                acceptance: { type: 'array', items: { type: 'string' }, description: 'Deterministic verification or acceptance checks (nonempty).' },
                evidence: { type: 'array', items: { type: 'string' }, description: 'Optional verification evidence references.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['task', 'scope', 'acceptance'],
            additionalProperties: false
        }
    },
    {
        name: 'steward_record_question',
        description: 'Record an open or resolved design question, working assumptions, and resolution in the journal.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_PROP,
                question: { type: 'string', description: 'The open or resolved question.' },
                assumptions: { type: 'array', items: { type: 'string' }, description: 'Working assumptions while the question is open.' },
                resolution: { type: ['string', 'null'], description: 'Confirmed resolution text or null if unresolved.' },
                supersedes: { type: ['string', 'null'], description: 'Optional SHA-256 hash of a prior question record being replaced, or null.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional indexing tags.' }
            },
            required: ['question'],
            additionalProperties: false
        }
    }
];

/**
 * Exposes core Steward resources.
 */
export const STEWARD_RESOURCES = [
    { uri: 'steward://policy', name: 'Project Policy', mimeType: 'application/json', description: 'Active policy rules and budget configuration.' },
    { uri: 'steward://verification-plan', name: 'Verification Plan', mimeType: 'application/json', description: 'Approved verification checks and execution timeouts.' },
    { uri: 'steward://journal/head', name: 'Journal Head', mimeType: 'application/json', description: 'Current journal sequence count and latest head hash.' },
    { uri: 'steward://checkpoint/latest', name: 'Latest Checkpoint', mimeType: 'application/json', description: 'Most recent checkpoint progress record.' },
    { uri: 'steward://doctor', name: 'System Doctor', mimeType: 'application/json', description: 'Health check and trust status report.' },
    { uri: 'steward://trust/status', name: 'Trust Status', mimeType: 'application/json', description: 'Non-throwing trust and bundle diagnostic report.' }
];

function optStr(val) {
    return typeof val === 'string' && !val.trim() ? undefined : val;
}

/**
 * Executes the steward_policy_eval tool.
 */
function executePolicyEval(root, args) {
    root = rootOf(root);
    const { policy } = requireTrust(root);
    const toolVal = optStr(args.tool);
    const raw = {
        event: args.event,
        text: args.text,
        tool: args.event === 'tool' ? (toolVal ?? 'generic') : (toolVal ?? null),
        paths: args.paths ?? [],
        sessionId: optStr(args.sessionId) ?? null
    };
    const eventObj = normalizeInput('generic', raw, root);
    return evaluate(policy, eventObj);
}

/**
 * Executes the steward_recall tool.
 */
function executeRecall(root, args) {
    return queryJournal(root, {
        type: optStr(args.type),
        text: args.text,
        tag: optStr(args.tag),
        since: optStr(args.since),
        until: optStr(args.until),
        limit: args.limit,
        history: args.history,
        recordId: optStr(args.recordId),
        sessionId: optStr(args.sessionId)
    });
}

/**
 * Executes the steward_checkpoint tool.
 */
async function executeCheckpoint(root, args) {
    const checkpointData = {
        summary: args.summary,
        next: args.next,
        blockers: args.blockers ?? [],
        ...(args.tags !== undefined ? { tags: args.tags } : {})
    };
    const sessionId = optStr(args.sessionId);
    if (sessionId !== undefined && sessionId !== null) {
        insist(typeof sessionId === 'string' && sessionId.length <= 256, 'USAGE', 'Invalid session ID.');
        checkpointData.session = sha256(sessionId);
    }
    return appendEntry(root, {
        type: 'checkpoint',
        data: checkpointData
    });
}

/**
 * Executes the steward_schedule_manage tool.
 */
async function executeScheduleManage(root, args) {
    const schedData = {
        title: args.title,
        dueAt: args.dueAt,
        status: args.status,
        members: args.members ?? [],
        ...(args.tags !== undefined ? { tags: args.tags } : {})
    };
    const schedId = optStr(args.id);
    const supersedes = optStr(args.supersedes) ?? null;
    if (schedId) {
        schedData.id = schedId;
        schedData.supersedes = supersedes;
    } else if (supersedes) {
        schedData.supersedes = supersedes;
    }
    return appendEntry(root, {
        type: 'schedule',
        data: schedData
    });
}

const TOOL_ALIASES = {
    steward_eval: 'steward_policy_eval',
    steward_evaluate: 'steward_policy_eval',
    steward_gate: 'steward_completion_gate'
};

const TOOL_SCHEMA_KEYS = Object.fromEntries([
    ...STEWARD_TOOLS.map(t => [t.name, Object.keys(t.inputSchema.properties || {})]),
    ...Object.entries(TOOL_ALIASES).map(([alias, canonical]) => {
        const tool = STEWARD_TOOLS.find(t => t.name === canonical);
        return [alias, Object.keys(tool?.inputSchema.properties || {})];
    }),
    ['steward_status', ['project']],
    ['steward_doctor', ['project']]
]);

const TOOL_DISPATCHERS = {
    steward_policy_eval: (root, args) => executePolicyEval(root, args),
    steward_eval: (root, args) => executePolicyEval(root, args),
    steward_evaluate: (root, args) => executePolicyEval(root, args),
    steward_recall: (root, args) => executeRecall(root, args),
    steward_record_decision: (root, args) => appendEntry(root, {
        type: 'decision',
        data: {
            statement: args.statement,
            authority: args.authority,
            supersedes: optStr(args.supersedes) ?? null,
            ...(args.tags !== undefined ? { tags: args.tags } : {})
        }
    }),
    steward_checkpoint: (root, args) => executeCheckpoint(root, args),
    steward_verify: (root) => runVerification(root),
    steward_completion_gate: (root, args) => completionGate(root, optStr(args.evidence) ?? null),
    steward_gate: (root, args) => completionGate(root, optStr(args.evidence) ?? null),
    steward_record_knowledge: (root, args) => appendEntry(root, {
        type: 'knowledge',
        data: {
            claim: args.claim,
            basis: args.basis,
            sources: args.sources ?? [],
            expiresAt: optStr(args.expiresAt) ?? null,
            ...(args.tags !== undefined ? { tags: args.tags } : {})
        }
    }),
    steward_schedule_manage: (root, args) => executeScheduleManage(root, args),
    steward_goal_manage: (root, args) => appendEntry(root, {
        type: 'goal',
        data: {
            objective: args.objective,
            acceptance: args.acceptance ?? [],
            status: args.status,
            evidence: args.evidence ?? [],
            ...(args.tags !== undefined ? { tags: args.tags } : {})
        }
    }),
    steward_record_handoff: (root, args) => appendEntry(root, {
        type: 'handoff',
        data: {
            task: args.task,
            scope: args.scope ?? [],
            constraints: args.constraints ?? [],
            acceptance: args.acceptance ?? [],
            evidence: args.evidence ?? [],
            ...(args.tags !== undefined ? { tags: args.tags } : {})
        }
    }),
    steward_record_question: (root, args) => appendEntry(root, {
        type: 'question',
        data: {
            question: args.question,
            assumptions: args.assumptions ?? [],
            resolution: optStr(args.resolution) ?? null,
            supersedes: optStr(args.supersedes) ?? null,
            ...(args.tags !== undefined ? { tags: args.tags } : {})
        }
    }),
    steward_status: (root) => doctor(root, null, { allowUntrusted: true }),
    steward_doctor: (root) => doctor(root, null, { allowUntrusted: true })
};

/**
 * Handles an MCP tool invocation.
 *
 * @param {string} root - Project root.
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @returns {Promise<object>} Result payload.
 */
export async function executeTool(root, name, args = {}) {
    insist(args === undefined || (args !== null && typeof args === 'object' && !Array.isArray(args)), 'SCHEMA', 'Tool arguments must be an object.');
    const handler = typeof name === 'string' && Object.hasOwn(TOOL_DISPATCHERS, name) ? TOOL_DISPATCHERS[name] : null;
    insist(handler, 'USAGE', `Unknown MCP tool: ${name}`);
    const resolvedArgs = args ?? {};
    object(resolvedArgs, TOOL_SCHEMA_KEYS[name] ?? [], name);
    insist(resolvedArgs.project === undefined || typeof resolvedArgs.project === 'string', 'SCHEMA', `${name}.project must be a string.`);
    const targetRoot = rootOf(optStr(resolvedArgs.project) ?? root);
    return handler(targetRoot, resolvedArgs);
}

const RESOURCE_HANDLERS = {
    'steward://policy': (root, uri) => {
        const { policy } = requireTrust(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(policy, null, 2) };
    },
    'steward://policy/active': (root, uri) => {
        const { policy } = requireTrust(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(policy, null, 2) };
    },
    'steward://verification-plan': (root, uri) => {
        const { plan } = requireTrust(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) };
    },
    'steward://journal/head': (root, uri) => {
        const rows = readJournal(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(journalHead(rows), null, 2) };
    },
    'steward://journal/summary': (root, uri) => {
        const rows = readJournal(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(journalHead(rows), null, 2) };
    },
    'steward://checkpoint/latest': (root, uri) => {
        const checkpoint = latestCheckpoint(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(checkpoint, null, 2) };
    },
    'steward://doctor': (root, uri) => {
        const result = doctor(root, null, { allowUntrusted: true });
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
    },
    'steward://trust/status': (root, uri) => {
        const result = doctor(root, null, { allowUntrusted: true });
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
    }
};

function parseResourceTarget(root, uri) {
    insist(typeof uri === 'string' && uri.trim(), 'USAGE', `Unknown MCP resource: ${uri}`);
    const qIndex = uri.indexOf('?');
    if (qIndex < 0) {
        return { baseUri: uri, targetRoot: rootOf(root) };
    }
    const baseUri = uri.slice(0, qIndex);
    const params = new URLSearchParams(uri.slice(qIndex + 1));
    for (const key of params.keys()) {
        insist(key === 'project', 'USAGE', `Unsupported MCP resource query parameter: ${key}`);
    }
    const projectParam = optStr(params.get('project') ?? undefined);
    return { baseUri, targetRoot: rootOf(projectParam ?? root) };
}

/**
 * Reads an MCP resource by URI.
 *
 * @param {string} root - Project root.
 * @param {string} uri - Resource URI.
 * @returns {object} Resource contents.
 */
export function readResource(root, uri) {
    const { baseUri, targetRoot } = parseResourceTarget(root, uri);
    const handler = Object.hasOwn(RESOURCE_HANDLERS, baseUri) ? RESOURCE_HANDLERS[baseUri] : null;
    insist(handler, 'USAGE', `Unknown MCP resource: ${uri}`);
    return handler(targetRoot, uri);
}

/**
 * Handles tools/call JSON-RPC method.
 */
async function handleToolsCall(root, id, params) {
    const { name, arguments: toolArgs } = params || {};
    try {
        const output = await executeTool(root, name, toolArgs);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                isError: false
            }
        };
    } catch (err) {
        const e = publicError(err);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text: `Steward Error [${e.code}]: ${e.message}` }],
                isError: true
            }
        };
    }
}

/**
 * Handles resources/read JSON-RPC method.
 */
function handleResourcesRead(root, id, params) {
    const { uri } = params || {};
    try {
        const resource = readResource(root, uri);
        return {
            jsonrpc: '2.0',
            id,
            result: { contents: [resource] }
        };
    } catch (err) {
        const e = publicError(err);
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32002, message: `Steward Error [${e.code}]: ${e.message}` }
        };
    }
}

/**
 * Processes a single JSON-RPC 2.0 message and generates a JSON-RPC response or null (for notifications).
 *
 * @param {string} root - Project root.
 * @param {object} req - JSON-RPC request object.
 * @returns {Promise<object|null>} JSON-RPC response or null.
 */
export async function handleMcpMessage(root, req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = req;
    const isNotification = !Object.hasOwn(req, 'id') || id === undefined;
    const validId = isNotification || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    const responseId = (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) ? id : null;
    if (
        !validId ||
        req.jsonrpc !== '2.0' ||
        typeof method !== 'string' ||
        !method.trim() ||
        (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params)))
    ) {
        return { jsonrpc: '2.0', id: responseId, error: { code: -32600, message: 'Invalid Request' } };
    }

    // Notifications require no response
    if (isNotification) {
        return null;
    }

    try {
        root = rootOf(root);
        switch (method) {
            case 'initialize': {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {},
                            resources: {}
                        },
                        serverInfo: {
                            name: 'steward',
                            version: VERSION
                        }
                    }
                };
            }
            case 'ping': {
                return { jsonrpc: '2.0', id, result: {} };
            }
            case 'tools/list': {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { tools: STEWARD_TOOLS }
                };
            }
            case 'tools/call': {
                return await handleToolsCall(root, id, params);
            }
            case 'resources/list': {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { resources: STEWARD_RESOURCES }
                };
            }
            case 'resources/read': {
                return handleResourcesRead(root, id, params);
            }
            default: {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32601, message: `Method not found: ${method}` }
                };
            }
        }
    } catch (err) {
        const e = publicError(err);
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `Internal error [${e.code}]: ${e.message}` }
        };
    }
}

/**
 * Formats ready-to-use MCP configuration snippets for major coding agent hosts.
 *
 * @param {object} options
 * @param {string} [options.host='claude'] - Target host ('claude', 'cursor', 'antigravity', 'generic').
 * @param {string} [options.project] - Target project path.
 * @param {string} [options.runner] - Path to steward executable or bin/steward.mjs.
 * @returns {object} JSON configuration snippet.
 */
export function formatMcpConfig({ host = 'claude', project = process.cwd(), runner = null } = {}) {
    let resolvedRoot;
    try {
        resolvedRoot = rootOf(project);
    } catch {
        resolvedRoot = path.resolve(project);
    }
    const resolvedRunner = runner ? path.resolve(runner) : path.resolve(PACKAGE_ROOT, 'bin/steward.mjs');

    const serverDef = {
        command: process.execPath,
        args: [resolvedRunner, 'mcp', '--project', resolvedRoot]
    };

    switch (host.toLowerCase()) {
        case 'antigravity':
            return {
                mcpServers: {
                    steward: serverDef
                },
                servers: {
                    steward: {
                        transport: 'stdio',
                        command: serverDef.command,
                        args: serverDef.args
                    }
                }
            };
        case 'cursor':
        case 'claude':
        default:
            return {
                mcpServers: {
                    steward: serverDef
                }
            };
    }
}

/**
 * Starts the stdio JSON-RPC 2.0 MCP server loop.
 *
 * @param {string} root - Project root.
 * @param {object} [streams] - In and out stream overrides.
 * @returns {Promise<void>} Resolves when stream closes.
 */
export function startMcpServer(root, { inStream = process.stdin, outStream = process.stdout } = {}) {
    root = rootOf(root);
    let buffer = '';
    let bufferBytes = 0;
    let discardingOversized = false;

    return new Promise((resolve) => {
        let isClosed = false;
        let queue = Promise.resolve();

        const close = () => {
            if (!isClosed) {
                isClosed = true;
                resolve();
            }
        };

        const writeParseError = (message = 'Parse error') => {
            const parseErr = { jsonrpc: '2.0', id: null, error: { code: -32700, message } };
            if (!isClosed && !outStream.destroyed) {
                outStream.write(JSON.stringify(parseErr) + '\n');
            }
        };

        inStream.on('error', close);
        outStream.on('error', close);

        inStream.setEncoding('utf8');

        async function processLine(line) {
            const trimmed = line.trim();
            if (!trimmed || isClosed) return;

            let message;
            try {
                message = JSON.parse(trimmed);
            } catch {
                writeParseError('Parse error');
                return;
            }

            try {
                const response = await handleMcpMessage(root, message);
                if (response !== null && !isClosed && !outStream.destroyed) {
                    outStream.write(JSON.stringify(response) + '\n');
                }
            } catch (err) {
                const e = publicError(err);
                const respId = (typeof message?.id === 'string' || (typeof message?.id === 'number' && Number.isFinite(message.id))) ? message.id : null;
                const internalErr = { jsonrpc: '2.0', id: respId, error: { code: -32603, message: `Internal error [${e.code}]: ${e.message}` } };
                if (!isClosed && !outStream.destroyed) {
                    outStream.write(JSON.stringify(internalErr) + '\n');
                }
            }
        }

        inStream.on('data', (chunk) => {
            const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const nlIdx = str.indexOf('\n');
            if (nlIdx === -1) {
                if (discardingOversized) return;
                const chunkBytes = Buffer.byteLength(str, 'utf8');
                if (bufferBytes + chunkBytes > MAX_LINE_BYTES) {
                    buffer = '';
                    bufferBytes = 0;
                    discardingOversized = true;
                } else {
                    buffer += str;
                    bufferBytes += chunkBytes;
                }
                return;
            }

            const parts = str.split('\n');
            const firstPart = parts[0];
            const firstBytes = Buffer.byteLength(firstPart, 'utf8');
            if (discardingOversized || bufferBytes + firstBytes > MAX_LINE_BYTES) {
                buffer = '';
                bufferBytes = 0;
                discardingOversized = false;
                queue = queue.then(() => writeParseError('Parse error: message exceeds 1 MiB limit')).catch(() => {});
            } else {
                const fullLine = buffer + firstPart;
                buffer = '';
                bufferBytes = 0;
                queue = queue.then(() => processLine(fullLine)).catch(() => {});
            }

            for (let i = 1; i < parts.length - 1; i++) {
                const line = parts[i];
                if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
                    queue = queue.then(() => writeParseError('Parse error: message exceeds 1 MiB limit')).catch(() => {});
                } else {
                    queue = queue.then(() => processLine(line)).catch(() => {});
                }
            }

            const tail = parts[parts.length - 1];
            const tailBytes = Buffer.byteLength(tail, 'utf8');
            if (tailBytes > MAX_LINE_BYTES) {
                buffer = '';
                bufferBytes = 0;
                discardingOversized = true;
            } else {
                buffer = tail;
                bufferBytes = tailBytes;
                discardingOversized = false;
            }
        });

        inStream.on('end', () => {
            if (discardingOversized) {
                discardingOversized = false;
                queue = queue.then(() => writeParseError('Parse error: message exceeds 1 MiB limit')).catch(() => {});
            } else if (buffer.trim()) {
                const remaining = buffer;
                buffer = '';
                bufferBytes = 0;
                queue = queue.then(() => processLine(remaining)).catch(() => {});
            }
            queue.then(close).catch(close);
        });
    });
}

