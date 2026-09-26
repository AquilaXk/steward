import path from 'node:path';
import { rootOf } from '../fs.mjs';
import { VERSION } from '../version.mjs';
import { evaluate } from '../engine.mjs';
import { loadBundle } from '../trust.mjs';
import { appendEntry, readJournal, journalHead, queryJournal, latestCheckpoint } from '../journal.mjs';
import { runVerification, completionGate } from '../verify.mjs';
import { doctor } from '../doctor.mjs';
import { publicError } from '../errors.mjs';

/**
 * 8 Core Steward MCP Tools definition.
 */
export const STEWARD_TOOLS = [
    {
        name: 'steward_policy_eval',
        description: 'Evaluate an action event against trusted project policy. Returns allow/deny, matched rules, and injected context guidance.',
        inputSchema: {
            type: 'object',
            properties: {
                event: { type: 'string', enum: ['prompt', 'tool', 'session'], description: 'The event type to evaluate.' },
                text: { type: 'string', description: 'The prompt text, command string, or description.' },
                tool: { type: 'string', description: 'Tool name if event is "tool" (e.g., shell, file.write).' },
                paths: { type: 'array', items: { type: 'string' }, description: 'Project paths accessed by the tool.' },
                sessionId: { type: 'string', description: 'Optional session identifier.' }
            },
            required: ['event', 'text']
        }
    },
    {
        name: 'steward_recall',
        description: 'Query journal records (decisions, knowledge, goals, checkpoints, schedules, handoffs) with filtering and freshness checks.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['decision', 'question', 'knowledge', 'goal', 'checkpoint', 'schedule', 'handoff', 'verification'] },
                text: { type: 'string', description: 'Search text within journal records.' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                history: { type: 'boolean', default: false, description: 'Include superseded and expired records.' },
                recordId: { type: 'string', description: 'Filter by specific record ID.' },
                sessionId: { type: 'string', description: 'Filter checkpoints by session ID.' }
            }
        }
    },
    {
        name: 'steward_record_decision',
        description: 'Record an explicitly confirmed architectural or design decision in the immutable, verifiable journal.',
        inputSchema: {
            type: 'object',
            properties: {
                statement: { type: 'string', description: 'The decision statement.' },
                authority: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: ['user', 'delegated'] },
                        reference: { type: 'string', description: 'Source reference (issue, conversation, PR).' },
                        quote: { type: 'string', description: 'Exact authorizing quote.' }
                    },
                    required: ['kind', 'reference', 'quote']
                },
                supersedes: { type: 'string', description: 'SHA-256 hash of a prior decision record being replaced, or null.' }
            },
            required: ['statement', 'authority']
        }
    },
    {
        name: 'steward_checkpoint',
        description: 'Persist session progress summary, next actions, and blockers into the journal.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Concise summary of progress made so far.' },
                next: { type: 'string', description: 'Concrete next action to execute.' },
                blockers: { type: 'array', items: { type: 'string' }, description: 'Any blocking issues or open questions.' },
                sessionId: { type: 'string', description: 'Optional session identifier to bind checkpoint restoration.' }
            },
            required: ['summary', 'next']
        }
    },
    {
        name: 'steward_verify',
        description: 'Run the project approved verification plan commands and capture cryptographic evidence of test outcomes.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'steward_completion_gate',
        description: 'Verify whether the latest recorded evidence satisfies the verification plan and unchanged source snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                evidence: { type: 'string', description: 'Optional specific verification evidence SHA-256 hash.' }
            }
        }
    },
    {
        name: 'steward_record_knowledge',
        description: 'Record verified domain knowledge, conventions, or constraints into the immutable journal.',
        inputSchema: {
            type: 'object',
            properties: {
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
                        required: ['reference', 'checkedAt']
                    }
                },
                expiresAt: { type: 'string', description: 'Optional ISO timestamp after which this knowledge expires.' }
            },
            required: ['claim', 'basis']
        }
    },
    {
        name: 'steward_schedule_manage',
        description: 'Create or revise a milestone schedule in the project journal.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Milestone or task title.' },
                dueAt: { type: 'string', description: 'Due date as ISO timestamp.' },
                status: { type: 'string', enum: ['planned', 'staged', 'completed', 'cancelled'] },
                members: { type: 'array', items: { type: 'string' }, description: 'Responsible agents or users.' },
                id: { type: 'string', description: 'Optional stable identifier for schedule tracking.' },
                supersedes: { type: ['string', 'null'], description: 'Optional SHA-256 hash of previous schedule version being replaced, or null.' }
            },
            required: ['title', 'dueAt', 'status']
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
    { uri: 'steward://doctor', name: 'System Doctor', mimeType: 'application/json', description: 'Health check and trust status report.' }
];

/**
 * Executes the steward_policy_eval tool.
 */
function executePolicyEval(root, args) {
    const { policy } = loadBundle(root);
    const eventObj = {
        event: args.event || 'prompt',
        text: args.text || '',
        tool: args.event === 'tool' ? (args.tool || 'generic') : null,
        paths: Array.isArray(args.paths) ? args.paths : [],
        sessionId: args.sessionId || null
    };
    return evaluate(policy, eventObj);
}

/**
 * Executes the steward_recall tool.
 */
function executeRecall(root, args) {
    return queryJournal(root, {
        type: args.type,
        text: args.text,
        limit: args.limit,
        history: args.history,
        recordId: args.recordId,
        sessionId: args.sessionId
    });
}

/**
 * Executes the steward_checkpoint tool.
 */
async function executeCheckpoint(root, args) {
    const checkpointData = {
        summary: args.summary,
        next: args.next,
        blockers: Array.isArray(args.blockers) ? args.blockers : []
    };
    if (args.sessionId) {
        const { sha256 } = await import('../fs.mjs');
        checkpointData.session = sha256(args.sessionId);
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
        members: Array.isArray(args.members) ? args.members : []
    };
    if (args.id) {
        schedData.id = args.id;
        schedData.supersedes = args.supersedes ?? null;
    } else if (args.supersedes) {
        schedData.supersedes = args.supersedes;
    }
    return appendEntry(root, {
        type: 'schedule',
        data: schedData
    });
}

const TOOL_DISPATCHERS = {
    steward_policy_eval: (root, args) => executePolicyEval(root, args),
    steward_recall: (root, args) => executeRecall(root, args),
    steward_record_decision: (root, args) => appendEntry(root, {
        type: 'decision',
        data: {
            statement: args.statement,
            authority: args.authority,
            supersedes: args.supersedes ?? null
        }
    }),
    steward_checkpoint: (root, args) => executeCheckpoint(root, args),
    steward_verify: (root) => runVerification(root),
    steward_completion_gate: (root, args) => completionGate(root, args.evidence || null),
    steward_record_knowledge: (root, args) => appendEntry(root, {
        type: 'knowledge',
        data: {
            claim: args.claim,
            basis: args.basis,
            sources: Array.isArray(args.sources) ? args.sources : [],
            expiresAt: args.expiresAt ?? null
        }
    }),
    steward_schedule_manage: (root, args) => executeScheduleManage(root, args)
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
    const handler = TOOL_DISPATCHERS[name];
    if (!handler) {
        throw new Error(`Unknown MCP tool: ${name}`);
    }
    return handler(root, args);
}

const RESOURCE_HANDLERS = {
    'steward://policy': (root, uri) => {
        const { policy } = loadBundle(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(policy, null, 2) };
    },
    'steward://verification-plan': (root, uri) => {
        const { plan } = loadBundle(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) };
    },
    'steward://journal/head': (root, uri) => {
        const rows = readJournal(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(journalHead(rows), null, 2) };
    },
    'steward://checkpoint/latest': (root, uri) => {
        const checkpoint = latestCheckpoint(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(checkpoint, null, 2) };
    },
    'steward://doctor': (root, uri) => {
        const result = doctor(root);
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
    }
};

/**
 * Reads an MCP resource by URI.
 *
 * @param {string} root - Project root.
 * @param {string} uri - Resource URI.
 * @returns {object} Resource contents.
 */
export function readResource(root, uri) {
    const handler = RESOURCE_HANDLERS[uri];
    if (!handler) {
        throw new Error(`Unknown MCP resource: ${uri}`);
    }
    return handler(root, uri);
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
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32002, message: err.message }
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
    if (!req || typeof req !== 'object') {
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = req;

    // Notifications require no response
    if (id === undefined || id === null) {
        return null;
    }

    try {
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
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `Internal error: ${err.message}` }
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
    const resolvedRunner = runner ? path.resolve(runner) : path.resolve(resolvedRoot, 'bin/steward.mjs');

    const serverDef = {
        command: process.execPath,
        args: [resolvedRunner, 'mcp', '--project', resolvedRoot]
    };

    switch (host.toLowerCase()) {
        case 'cursor':
            return {
                mcpServers: {
                    steward: serverDef
                }
            };
        case 'antigravity':
            return {
                servers: {
                    steward: {
                        transport: 'stdio',
                        command: serverDef.command,
                        args: serverDef.args
                    }
                }
            };
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

    return new Promise((resolve) => {
        let isClosed = false;
        let queue = Promise.resolve();

        const close = () => {
            if (!isClosed) {
                isClosed = true;
                resolve();
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
                const parseErr = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
                if (!isClosed && !outStream.destroyed) {
                    outStream.write(JSON.stringify(parseErr) + '\n');
                }
                return;
            }

            try {
                const response = await handleMcpMessage(root, message);
                if (response !== null && !isClosed && !outStream.destroyed) {
                    outStream.write(JSON.stringify(response) + '\n');
                }
            } catch (err) {
                const internalErr = { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${err.message}` } };
                if (!isClosed && !outStream.destroyed) {
                    outStream.write(JSON.stringify(internalErr) + '\n');
                }
            }
        }

        inStream.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Retain remainder in buffer

            for (const line of lines) {
                queue = queue.then(() => processLine(line)).catch(() => {});
            }
        });

        inStream.on('end', () => {
            if (buffer.trim()) {
                const remaining = buffer;
                buffer = '';
                queue = queue.then(() => processLine(remaining)).catch(() => {});
            }
            queue.then(close).catch(close);
        });
    });
}
