import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { sandbox, plan } from './helpers.mjs';
import { handleMcpMessage, formatMcpConfig, startMcpServer, STEWARD_TOOLS, STEWARD_RESOURCES } from '../src/adapters/mcp.mjs';
import { appendEntry } from '../src/journal.mjs';

test('MCP initialize returns standard protocol response and 8 tools', async (t) => {
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
    assert.equal(toolsRes.result.tools.length, 8);
    const toolNames = toolsRes.result.tools.map(t => t.name);
    assert(toolNames.includes('steward_policy_eval'));
    assert(toolNames.includes('steward_recall'));
    assert(toolNames.includes('steward_record_decision'));
    assert(toolNames.includes('steward_checkpoint'));
    assert(toolNames.includes('steward_verify'));
    assert(toolNames.includes('steward_completion_gate'));
    assert(toolNames.includes('steward_record_knowledge'));
    assert(toolNames.includes('steward_schedule_manage'));
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
