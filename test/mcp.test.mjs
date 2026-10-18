import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { sandbox, plan, write, policy, rule } from './helpers.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { handleMcpMessage, formatMcpConfig, startMcpServer, STEWARD_TOOLS, STEWARD_RESOURCES } from '../src/adapters/mcp.mjs';
import { appendEntry } from '../src/journal.mjs';

test('MCP initialize returns standard protocol response and 11 tools with strict inputSchema', async (t) => {
    const { root } = sandbox(t);

    const initRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
    });
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result.serverInfo.name, 'steward');
    assert.ok(initRes.result.capabilities.tools);
    assert.ok(initRes.result.capabilities.resources);

    const toolsRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
    });
    assert.equal(toolsRes.result.tools.length, 11);
    const toolNames = toolsRes.result.tools.map(t => t.name);
    assert(toolNames.includes('steward_policy_eval'));
    assert(toolNames.includes('steward_recall'));
    assert(toolNames.includes('steward_record_decision'));
    assert(toolNames.includes('steward_checkpoint'));
    assert(toolNames.includes('steward_verify'));
    assert(toolNames.includes('steward_completion_gate'));
    assert(toolNames.includes('steward_record_knowledge'));
    assert(toolNames.includes('steward_schedule_manage'));
    assert(toolNames.includes('steward_goal_manage'));
    assert(toolNames.includes('steward_record_handoff'));
    assert(toolNames.includes('steward_record_question'));
    for (const tool of toolsRes.result.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} inputSchema must set additionalProperties: false`);
    }
});

test('MCP tools/call executes policy evaluation and records decisions', async (t) => {
    const { root } = sandbox(t);

    // Call policy evaluation
    const evalRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
            name: 'steward_policy_eval',
            arguments: {
                event: 'prompt',
                text: 'Please review and build'
            }
        }
    });
    assert.equal(evalRes.result.isError, false);
    const evalData = JSON.parse(evalRes.result.content[0].text);
    assert.equal(evalData.decision, 'allow');

    // Call record decision
    const decRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
            name: 'steward_record_decision',
            arguments: {
                statement: 'Standardize on MCP stdio transport',
                authority: { kind: 'user', reference: 'conversation', quote: 'build mcp adapter' }
            }
        }
    });
    assert.equal(decRes.result.isError, false);
    const decData = JSON.parse(decRes.result.content[0].text);
    assert.equal(decData.type, 'decision');
    assert.ok(decData.hash);

    // Recall decision via MCP
    const recallRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
            name: 'steward_recall',
            arguments: {
                type: 'decision'
            }
        }
    });
    const recallData = JSON.parse(recallRes.result.content[0].text);
    assert.equal(recallData.total, 1);
    assert.equal(recallData.rows[0].data.statement, 'Standardize on MCP stdio transport');
});

test('MCP resources list and read return valid project state', async (t) => {
    const { root } = sandbox(t);

    const listRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/list'
    });
    assert(listRes.result.resources.length >= 4);

    const readRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/read',
        params: { uri: 'steward://policy' }
    });
    assert.equal(readRes.result.contents[0].uri, 'steward://policy');
    const policy = JSON.parse(readRes.result.contents[0].text);
    assert.equal(policy.version, 1);
});

test('formatMcpConfig outputs valid client configurations', () => {
    const claudeCfg = formatMcpConfig({ host: 'claude', project: '/tmp/test-proj' });
    assert(claudeCfg.mcpServers.steward.args.includes('mcp'));

    const cursorCfg = formatMcpConfig({ host: 'cursor', project: '/tmp/test-proj' });
    assert(cursorCfg.mcpServers.steward.args.includes('mcp'));

    const antigravityCfg = formatMcpConfig({ host: 'antigravity', project: '/tmp/test-proj' });
    assert(antigravityCfg.mcpServers.steward.args.includes('mcp'));
    assert.equal(antigravityCfg.servers.steward.transport, 'stdio');
});

test('startMcpServer executes stream communication end-to-end', async (t) => {
    const { root } = sandbox(t);
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    let output = '';
    outStream.on('data', chunk => {
        output += chunk.toString();
    });

    const serverPromise = startMcpServer(root, { inStream, outStream });

    // Send initialize request
    inStream.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }) + '\n');
    inStream.end();

    await serverPromise;

    const response = JSON.parse(output.trim());
    assert.equal(response.id, 10);
    assert.equal(response.result.serverInfo.name, 'steward');
});

test('MCP tools/call steward_schedule_manage handles initial milestone with id', async (t) => {
    const { root } = sandbox(t);

    const schedRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
            name: 'steward_schedule_manage',
            arguments: {
                title: 'Initial Sprint',
                dueAt: '2026-10-01T00:00:00Z',
                status: 'planned',
                id: 'sprint-1'
            }
        }
    });
    assert.equal(schedRes.result.isError, false);
    const schedData = JSON.parse(schedRes.result.content[0].text);
    assert.equal(schedData.type, 'schedule');
    assert.equal(schedData.data.id, 'sprint-1');
    assert.equal(schedData.data.supersedes, null);
});

test('startMcpServer handles message without trailing newline before EOF', async (t) => {
    const { root } = sandbox(t);
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    let output = '';
    outStream.on('data', chunk => {
        output += chunk.toString();
    });

    const serverPromise = startMcpServer(root, { inStream, outStream });
    // Write request without trailing newline and end stream
    inStream.write(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'ping' }));
    inStream.end();

    await serverPromise;
    const response = JSON.parse(output.trim());
    assert.equal(response.id, 30);
});

test('startMcpServer resolves cleanly on stream error', async (t) => {
    const { root } = sandbox(t);
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    const serverPromise = startMcpServer(root, { inStream, outStream });
    inStream.destroy(new Error('client abruptly disconnected'));

    await assert.doesNotReject(async () => {
        await serverPromise;
    });
});

test('MCP steward_policy_eval and policy/plan resources enforce bundle trust and path canonicalization', async (t) => {
    const { root: untrustedRoot } = sandbox(t, { trusted: false });

    const untrustedEval = await handleMcpMessage(untrustedRoot, {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
            name: 'steward_policy_eval',
            arguments: { event: 'prompt', text: 'hello' }
        }
    });
    assert.equal(untrustedEval.result.isError, true);
    assert.match(untrustedEval.result.content[0].text, /UNTRUSTED/);

    const untrustedPolicyRes = await handleMcpMessage(untrustedRoot, {
        jsonrpc: '2.0',
        id: 41,
        method: 'resources/read',
        params: { uri: 'steward://policy' }
    });
    assert.equal(untrustedPolicyRes.error.code, -32002);
    assert.match(untrustedPolicyRes.error.message, /trusted|UNTRUSTED/i);

    const { root } = sandbox(t);
    write(root, '.steward/policy.json', policy([
        rule({
            id: 'protect-env',
            on: ['tool'],
            effect: 'deny',
            priority: 900,
            required: false,
            body: 'Do not read .env files.',
            match: { pathPrefixes: ['.env'] }
        })
    ]));
    trustBundle(root, loadBundle(root).hash);

    const dotEnvEval = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
            name: 'steward_policy_eval',
            arguments: {
                event: 'tool',
                tool: 'read_file',
                text: 'read env',
                paths: ['./.env']
            }
        }
    });
    assert.equal(dotEnvEval.result.isError, false);
    const evalOut = JSON.parse(dotEnvEval.result.content[0].text);
    assert.equal(evalOut.decision, 'deny');
    assert.ok(evalOut.matched.includes('protect-env'));

    const invalidEventEval = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
            name: 'steward_policy_eval',
            arguments: {
                event: 'bogus',
                text: 'invalid event'
            }
        }
    });
    assert.equal(invalidEventEval.result.isError, true);
    assert.match(invalidEventEval.result.content[0].text, /BAD_EVENT/);
});

test('MCP handleMcpMessage enforces JSON-RPC 2.0 request invariants', async (t) => {
    const { root } = sandbox(t);

    const batchRes = await handleMcpMessage(root, []);
    assert.equal(batchRes.error.code, -32600);

    const badVerRes = await handleMcpMessage(root, { jsonrpc: '1.0', id: 50, method: 'ping' });
    assert.equal(badVerRes.id, 50);
    assert.equal(badVerRes.error.code, -32600);

    const badMethodRes = await handleMcpMessage(root, { jsonrpc: '2.0', id: 51, method: 123 });
    assert.equal(badMethodRes.id, 51);
    assert.equal(badMethodRes.error.code, -32600);

    const badIdRes = await handleMcpMessage(root, { jsonrpc: '2.0', id: { nested: 1 }, method: 'ping' });
    assert.equal(badIdRes.id, null);
    assert.equal(badIdRes.error.code, -32600);

    const nullIdRes = await handleMcpMessage(root, { jsonrpc: '2.0', id: null, method: 'ping' });
    assert.equal(nullIdRes.id, null);
    assert.equal(nullIdRes.error.code, -32600);

    const arrayParamsRes = await handleMcpMessage(root, { jsonrpc: '2.0', id: 52, method: 'ping', params: [1, 2] });
    assert.equal(arrayParamsRes.id, 52);
    assert.equal(arrayParamsRes.error.code, -32600);

    const protoToolRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: { name: 'toString', arguments: {} }
    });
    assert.equal(protoToolRes.result.isError, true);
    assert.match(protoToolRes.result.content[0].text, /Unknown MCP tool: toString/);

    const protoResourceRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 54,
        method: 'resources/read',
        params: { uri: 'toString' }
    });
    assert.equal(protoResourceRes.error.code, -32002);
    assert.match(protoResourceRes.error.message, /Unknown MCP resource: toString/);
});

test('MCP executes steward_checkpoint, steward_verify, steward_completion_gate, and all 5 resources', async (t) => {
    const { root } = sandbox(t, { plan: plan() });

    const cpRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 80,
        method: 'tools/call',
        params: {
            name: 'steward_checkpoint',
            arguments: {
                summary: 'Ready to verify Track 2',
                next: 'Run steward_verify',
                blockers: [],
                tags: ['checkpoint']
            }
        }
    });
    assert.equal(cpRes.result.isError, false);
    const cpOut = JSON.parse(cpRes.result.content[0].text);
    assert.equal(cpOut.type, 'checkpoint');
    assert.equal(cpOut.data.summary, 'Ready to verify Track 2');

    const verifyRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 81,
        method: 'tools/call',
        params: {
            name: 'steward_verify',
            arguments: {}
        }
    });
    assert.equal(verifyRes.result.isError, false);
    const verifyOut = JSON.parse(verifyRes.result.content[0].text);
    assert.equal(verifyOut.allPassed, true);
    assert.match(verifyOut.evidence, /^[a-f0-9]{64}$/);

    const gateRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 82,
        method: 'tools/call',
        params: {
            name: 'steward_completion_gate',
            arguments: { evidence: verifyOut.evidence }
        }
    });
    assert.equal(gateRes.result.isError, false);
    const gateOut = JSON.parse(gateRes.result.content[0].text);
    assert.equal(gateOut.pass, true);
    assert.equal(gateOut.evidence, verifyOut.evidence);

    for (const [idx, resourceDef] of STEWARD_RESOURCES.entries()) {
        const resRead = await handleMcpMessage(root, {
            jsonrpc: '2.0',
            id: 90 + idx,
            method: 'resources/read',
            params: { uri: resourceDef.uri }
        });
        assert.ok(resRead.result, `Expected resource result for ${resourceDef.uri}`);
        assert.equal(resRead.result.contents[0].uri, resourceDef.uri);
        assert.equal(resRead.result.contents[0].mimeType, 'application/json');
        const parsed = JSON.parse(resRead.result.contents[0].text);
        assert.ok(parsed && typeof parsed === 'object');
    }
});

test('startMcpServer enforces 1 MiB line limit and recovers for subsequent messages', async (t) => {
    const { root } = sandbox(t);
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    let output = '';
    outStream.on('data', chunk => {
        output += chunk.toString();
    });

    const serverPromise = startMcpServer(root, { inStream, outStream });
    const oversizedReq = JSON.stringify({ jsonrpc: '2.0', id: 59, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024 + 32) } });
    inStream.write(oversizedReq.slice(0, 600000));
    inStream.write(oversizedReq.slice(600000) + '\n');
    inStream.write(JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'ping' }) + '\n');
    inStream.end();

    await serverPromise;
    const lines = output.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].error.code, -32700);
    assert.equal(lines[1].id, 60);
    assert.deepEqual(lines[1].result, {});
});

test('formatMcpConfig resolves default runner to Steward package bin/steward.mjs', () => {
    const cfg = formatMcpConfig({ host: 'claude', project: '/tmp/external-workspace' });
    const runnerPath = cfg.mcpServers.steward.args[0].replaceAll('\\', '/');
    assert.ok(!runnerPath.includes('external-workspace'), `Expected package runner path, got ${runnerPath}`);
    assert.ok(runnerPath.endsWith('bin/steward.mjs'));
});

test('MCP tools support tags and tag/temporal filtering in steward_recall', async (t) => {
    const { root } = sandbox(t);

    const knowRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 70,
        method: 'tools/call',
        params: {
            name: 'steward_record_knowledge',
            arguments: {
                claim: 'Zero external dependencies required',
                basis: 'source',
                sources: [{ reference: 'package.json', checkedAt: '2026-10-17T00:00:00Z' }],
                tags: ['architecture', 'runtime']
            }
        }
    });
    assert.equal(knowRes.result.isError, false);

    const recallRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/call',
        params: {
            name: 'steward_recall',
            arguments: {
                tag: 'architecture'
            }
        }
    });
    assert.equal(recallRes.result.isError, false);
    const recallData = JSON.parse(recallRes.result.content[0].text);
    assert.equal(recallData.total, 1);
    assert.deepEqual(recallData.rows[0].data.tags, ['architecture', 'runtime']);
});

test('MCP executeTool rejects non-object arguments and normalizes empty-string optional arguments', async (t) => {
    const { root } = sandbox(t);

    const nonObjRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
            name: 'steward_recall',
            arguments: 'not-an-object'
        }
    });
    assert.equal(nonObjRes.result.isError, true);
    assert.match(nonObjRes.result.content[0].text, /SCHEMA/);

    const arrayArgsRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
            name: 'steward_recall',
            arguments: []
        }
    });
    assert.equal(arrayArgsRes.result.isError, true);
    assert.match(arrayArgsRes.result.content[0].text, /SCHEMA/);

    const emptyOptRecall = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
            name: 'steward_recall',
            arguments: {
                type: '',
                tag: '   ',
                since: '',
                until: '',
                recordId: '',
                sessionId: ''
            }
        }
    });
    assert.equal(emptyOptRecall.result.isError, false);

    const emptyOptCp = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
            name: 'steward_checkpoint',
            arguments: {
                summary: 'Checkpoint with empty sessionId',
                next: 'Verify',
                sessionId: '   '
            }
        }
    });
    assert.equal(emptyOptCp.result.isError, false);
});

test('MCP executes steward_goal_manage, steward_record_handoff, steward_record_question, aliases, and untrusted doctor resource', async (t) => {
    const { root } = sandbox(t, { plan: plan() });

    const goalRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 110,
        method: 'tools/call',
        params: {
            name: 'steward_goal_manage',
            arguments: {
                objective: 'Ship complete 11-tool MCP surface',
                acceptance: ['All 7 journal record types supported via MCP'],
                status: 'active',
                evidence: [],
                tags: ['mcp', 'goals']
            }
        }
    });
    assert.equal(goalRes.result.isError, false);
    const goalOut = JSON.parse(goalRes.result.content[0].text);
    assert.equal(goalOut.type, 'goal');
    assert.equal(goalOut.data.objective, 'Ship complete 11-tool MCP surface');
    assert.equal(goalOut.data.status, 'active');

    const handoffRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 111,
        method: 'tools/call',
        params: {
            name: 'steward_record_handoff',
            arguments: {
                task: 'Audit MCP schemas in isolated worktree',
                scope: ['src/adapters/mcp.mjs', 'test/mcp.test.mjs'],
                constraints: ['Do not modify src/engine.mjs'],
                acceptance: ['node --test test/mcp.test.mjs passes'],
                evidence: [],
                tags: ['delegation']
            }
        }
    });
    assert.equal(handoffRes.result.isError, false);
    const handoffOut = JSON.parse(handoffRes.result.content[0].text);
    assert.equal(handoffOut.type, 'handoff');
    assert.deepEqual(handoffOut.data.scope, ['src/adapters/mcp.mjs', 'test/mcp.test.mjs']);

    const questionRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 112,
        method: 'tools/call',
        params: {
            name: 'steward_record_question',
            arguments: {
                question: 'Should untrusted MCP doctor resource return structured JSON?',
                assumptions: ['MCP clients inspect trusted: false rather than JSON-RPC error codes'],
                resolution: 'Yes, pass allowUntrusted: true in MCP resource handler',
                tags: ['mcp', 'diagnostics']
            }
        }
    });
    assert.equal(questionRes.result.isError, false);
    const questionOut = JSON.parse(questionRes.result.content[0].text);
    assert.equal(questionOut.type, 'question');
    assert.equal(questionOut.data.resolution, 'Yes, pass allowUntrusted: true in MCP resource handler');

    const aliasEvalRes = await handleMcpMessage(root, {
        jsonrpc: '2.0',
        id: 113,
        method: 'tools/call',
        params: {
            name: 'steward_eval',
            arguments: { event: 'prompt', text: 'check alias' }
        }
    });
    assert.equal(aliasEvalRes.result.isError, false);
    assert.equal(JSON.parse(aliasEvalRes.result.content[0].text).decision, 'allow');

    const { root: untrustedRoot } = sandbox(t, { trusted: false });
    const untrustedDocRes = await handleMcpMessage(untrustedRoot, {
        jsonrpc: '2.0',
        id: 114,
        method: 'resources/read',
        params: { uri: 'steward://doctor' }
    });
    assert.ok(untrustedDocRes.result, 'steward://doctor on untrusted project should return structured resource');
    const docBody = JSON.parse(untrustedDocRes.result.contents[0].text);
    assert.equal(docBody.trusted, false);
    assert.equal(docBody.trustError.code, 'UNTRUSTED');

    const trustStatusRes = await handleMcpMessage(untrustedRoot, {
        jsonrpc: '2.0',
        id: 115,
        method: 'resources/read',
        params: { uri: 'steward://trust/status' }
    });
    assert.ok(trustStatusRes.result, 'steward://trust/status on untrusted project should return structured resource');
    assert.equal(JSON.parse(trustStatusRes.result.contents[0].text).trusted, false);
});

