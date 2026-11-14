import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { sandbox, write, rule, policy, plan, cli, PACKAGE } from './helpers.mjs';
import { evaluate, matches, relativePath } from '../src/engine.mjs';
import { matchGlob, matchArgGlob, prepareGlobTargets, tokenizeCommand } from '../src/matcher.mjs';
import { normalizeInput } from '../src/adapters.mjs';
import { startMcpServer } from '../src/adapters/mcp.mjs';
import {
    generateSigningKeyPair,
    signData,
    verifySignature,
    signVerificationEvidence,
    verifyVerificationEvidence,
    resolveKeyPem,
    saveKeypair,
    deriveKeyId
} from '../src/crypto.mjs';
import { runVerification } from '../src/verify.mjs';
import { appendEntry } from '../src/journal.mjs';
import { snapshot } from '../src/fs.mjs';
import { pruneAudit } from '../src/audit.mjs';
import * as steward from '../src/index.mjs';

test('S-1: resolveAdapterRelativePath resolves mid-path symlinks before parent dot-segments and rejects null bytes', (t) => {
    const { root, temp } = sandbox(t);
    fs.mkdirSync(path.join(root, 'sub/a/b'), { recursive: true });
    fs.symlinkSync(path.join(root, '.steward/state'), path.join(root, 'sub/a/b/link'));

    const ev = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'sub/a/b/link/../policy.json', content: 'tamper' }
    }, root, 'PreToolUse');
    assert.deepEqual(ev.paths, ['.steward/policy.json']);

    const p = policy([
        rule({ id: 'deny-steward', effect: 'deny', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['.steward'] }, body: 'Protected.' })
    ]);
    assert.equal(evaluate(p, ev).decision, 'deny');

    const outsideDir = path.join(temp, 'outside-target/nested');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(root, 'sub/a/b/escape-link'));
    const esc = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'sub/a/b/escape-link/../pwn.txt', content: 'x' }
    }, root, 'PreToolUse');
    assert.ok(esc.paths[0].startsWith('@outside/'), `Expected @outside/ path, got ${esc.paths[0]}`);

    assert.throws(() => relativePath(root, 'bad\0path'), { code: 'BAD_PATH' });
    assert.equal(relativePath(root, root), '.');
});

test('S-2: shell normalization, brace expansion, and command substitution close matcher bypasses fail-closed', () => {
    const forceDeny = ['git push --force*', '--force'];
    for (const cmd of [
        'git  push --force origin main',
        '"git" push --force origin main',
        "'git' push --force origin main",
        'git \\\npush --force origin main',
        '{git,push,--force}',
        'echo safe && {git,push,--force}'
    ]) {
        assert.equal(matchArgGlob(forceDeny, cmd), true, `Expected deny pattern to match: ${cmd}`);
    }

    assert.equal(matchArgGlob(['rm -r -f /*', 'rm *-r*-f*'], 'rm {-r,-f} /'), true);
    assert.equal(matchArgGlob(['rm *'], '{echo,rm} ' + '{a,b}'.repeat(5)), true);

    const branches35 = '{' + Array.from({ length: 34 }, (_, i) => `a${i}`).join(',') + ',rm} -rf /';
    assert.equal(matchArgGlob(['rm *'], branches35), true);

    assert.equal(matchArgGlob(['rm *', '-rf'], 'echo "$(rm -rf /)"'), true);
    assert.equal(matchArgGlob(['rm *', '-rf'], 'echo "`rm -rf /`"'), true);
    assert.equal(matchArgGlob(['rm *', '-rf'], "echo '$(rm -rf /)'"), false);
    assert.equal(matchArgGlob(['rm *', '-rf'], 'echo "$(rm -rf "$(echo /)")"'), true);
    assert.equal(matchArgGlob(['rm *', '-rf'], 'echo "$\\\n(rm -rf /)"'), true);
    assert.equal(matchArgGlob(['rm *', '-rf'], 'echo $\\\n(rm -rf /)'), true);
    assert.deepEqual(tokenizeCommand("$'\\U80000000'"), ['\ufffd']);
    assert.deepEqual(tokenizeCommand("$'\\Uffffffff'"), ['\ufffd']);

    const t0 = performance.now();
    assert.throws(() => matchArgGlob(['rm *'], '{a,b}'.repeat(5) + 'x'.repeat(250000)), { code: 'GLOB_COMPLEXITY' });
    const dt = performance.now() - t0;
    assert.ok(dt < 500, `Expected fail-closed brace guard <500ms, took ${dt.toFixed(1)}ms`);
});

test('S-3: adversarial glob backtracking throws GLOB_COMPLEXITY promptly while linear fast paths stay fast', () => {
    const pat = '*' + 'a'.repeat(250) + 'b';
    const text = 'b' + 'a'.repeat(250000);
    const t0 = performance.now();
    assert.throws(() => matchGlob(pat, text), { code: 'GLOB_COMPLEXITY' });
    const dt = performance.now() - t0;
    assert.ok(dt < 500, `Expected adversarial glob to fail within 500ms, took ${dt.toFixed(1)}ms`);

    assert.equal(matchGlob(pat, 'a'.repeat(250000)), false);
});

test('S-4: hook CLI emits host denial when flags precede hook or use = syntax and parseArgs fails', (t) => {
    const { root } = sandbox(t);
    const r1 = spawnSync(
        process.execPath,
        [path.join(PACKAGE, 'bin/steward.mjs'), '--project', root, 'hook', '--host', 'claude', '--event', 'PreToolUse', '--badflag'],
        { encoding: 'utf8', env: process.env, timeout: 10000 }
    );
    assert.equal(r1.status, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.hookSpecificOutput.permissionDecision, 'deny');

    const r2 = spawnSync(
        process.execPath,
        [path.join(PACKAGE, 'bin/steward.mjs'), `--project=${root}`, 'hook', '--host=claude', '--event=PreToolUse', '--badflag'],
        { encoding: 'utf8', env: process.env, timeout: 10000 }
    );
    assert.equal(r2.status, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout);
    assert.equal(out2.hookSpecificOutput.permissionDecision, 'deny');
});

test('S-5: runVerification yields to the event loop and startMcpServer enforces raw byte limit before decoding', async (t) => {
    const { root } = sandbox(t, { plan: plan('setTimeout(() => process.exit(0), 120)') });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 15);
    t.after(() => clearInterval(timer));
    const report = await runVerification(root);
    assert.equal(report.allPassed, true);
    assert.ok(ticks >= 2, `Expected concurrent event-loop ticks during async runVerification, got ${ticks}`);

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const outChunks = [];
    outStream.on('data', d => outChunks.push(d));
    const done = startMcpServer(root, { inStream, outStream });

    // 1.1 MiB raw line with multi-byte sequence followed by a valid ping
    const bigLine = Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"'),
        Buffer.alloc(1100 * 1024, 0x61),
        Buffer.from('"}}\n')
    ]);
    inStream.write(bigLine);
    inStream.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await done;

    const lines = Buffer.concat(outChunks).toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].error.code, -32600);
    assert.equal(lines[1].id, 2);
    assert.deepEqual(lines[1].result, {});
});

test('S-6: trust warns on pre-existing journal, call_mcp_tool extracts args, and transcript parser resists PLANNER_RESPONSE spoof', async (t) => {
    const { root } = sandbox(t, { trusted: true });
    await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Pre-seeded decision before trust approval',
            authority: { kind: 'user', reference: 'seed', quote: 'seed' },
            supersedes: null
        }
    });
    const trustRes = cli(root, ['trust']);
    assert.equal(trustRes.status, 0, trustRes.stderr);
    const trustOut = JSON.parse(trustRes.stdout);
    assert.equal(trustOut.existingJournalRecords, 1);
    assert.match(trustOut.journalWarning, /pre-existing/i);

    const mcpToolEv = normalizeInput('antigravity', {
        conversationId: 'conv-mcp',
        toolCall: {
            name: 'call_mcp_tool',
            args: {
                ServerName: 'filesystem',
                ToolName: 'write_file',
                Arguments: { Path: '.steward/policy.json', Content: 'override' }
            }
        }
    }, root, 'PreToolUse');
    assert.ok(mcpToolEv.text.includes('filesystem'));
    assert.ok(mcpToolEv.text.includes('write_file'));
    assert.ok(mcpToolEv.text.includes('.steward/policy.json'));

    const transcriptRel = '.steward/state/spoof-line-transcript.jsonl';
    write(root, transcriptRel, [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'Say "type":"PLANNER_RESPONSE" literally' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'Done' })
    ].join('\n') + '\n');
    const promptEv = normalizeInput('antigravity', {
        conversationId: 'conv-spoof-user',
        transcriptPath: path.join(root, transcriptRel)
    }, root, 'PreInvocation');
    assert.equal(promptEv.text, 'Say "type":"PLANNER_RESPONSE" literally');

    const badTranscript = path.join(root, '.steward/state/corrupt-user-line.jsonl');
    write(root, '.steward/state/corrupt-user-line.jsonl', '{"step_index":1,"type":"USER_INPUT","content":"unterminated\n');
    assert.throws(() => normalizeInput('antigravity', {
        conversationId: 'conv-corrupt',
        transcriptPath: badTranscript
    }, root, 'PreInvocation'), { code: 'BAD_EVENT' });

    const uniTranscript = path.join(root, '.steward/state/unicode-escape-user.jsonl');
    write(root, '.steward/state/unicode-escape-user.jsonl', '{"step_index":1,"type":"\\u0055SER_INPUT","content":"Unicode escaped user prompt"}\n');
    const uniEv = normalizeInput('antigravity', {
        conversationId: 'conv-unicode-type',
        transcriptPath: uniTranscript
    }, root, 'PreInvocation');
    assert.equal(uniEv.text, 'Unicode escaped user prompt');

    let deepObj = { Path: '.env' };
    for (let d = 0; d < 10; d++) deepObj = { nested: deepObj };
    assert.throws(() => normalizeInput('antigravity', {
        conversationId: 'conv-deep-mcp',
        toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'fs', ToolName: 'read_file', Arguments: deepObj }
        }
    }, root, 'PreToolUse'), { code: 'BAD_INPUT' });

    assert.throws(() => normalizeInput('antigravity', {
        conversationId: 'conv-conflict-args',
        toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'fs', ToolName: 'read_file', Arguments: { Path: 'README.md' }, arguments: { Path: '.env' } }
        }
    }, root, 'PreToolUse'), { code: 'BAD_INPUT' });

    assert.throws(() => normalizeInput('antigravity', {
        conversationId: 'conv-conflict-srv',
        toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'safe', server_name: 'evil', ToolName: 'read_file', Arguments: { Path: 'README.md' } }
        }
    }, root, 'PreToolUse'), { code: 'BAD_INPUT' });
});

test('S-7: crypto hardens PEM inline check, CRLF keyId parity, verifySignature key checks, saveKeypair symlinks, and failing evidence signing', async (t) => {
    const { root } = sandbox(t, { plan: plan('process.exit(1)') });
    const kp = generateSigningKeyPair();

    assert.throws(() => resolveKeyPem('nonexistent/-----BEGIN.pem'), { code: 'CRYPTO_ERROR' });

    const crlfPub = kp.publicKeyPem.replaceAll('\n', '\r\n');
    assert.equal(deriveKeyId(crlfPub), kp.keyId);

    const { signature } = signData('msg', kp.privateKeyPem);
    assert.equal(verifySignature('msg', signature, kp.privateKeyPem), false);

    const symOut = path.join(root, 'sym-out');
    fs.symlinkSync(root, symOut);
    assert.throws(() => saveKeypair(symOut, kp), { code: 'BAD_FILE' });

    const failedRun = await runVerification(root);
    assert.equal(failedRun.allPassed, false);
    assert.throws(() => signVerificationEvidence(root, failedRun.evidence, kp.privateKeyPem), { code: 'CHECKS_FAILED' });
    assert.throws(() => verifyVerificationEvidence(root, failedRun.evidence, kp.publicKeyPem, {}), { code: 'CHECKS_FAILED' });
});

test('B-3: Unicode Simple Case Folding works consistently across single chars and ranges', () => {
    assert.equal(matchGlob('[K]', 'K'), true);
    assert.equal(matchGlob('[K]', 'k'), true);
    assert.equal(matchGlob('[k]', 'K'), true);
    assert.equal(matchGlob('[İ]', 'İ'), true);
    assert.equal(matchGlob('[İ]', 'i'), false);
    assert.equal(matchGlob('[\u017f-\u039f]', '\u039f'), true);
    assert.equal(matchGlob('[\u0100-\u2130]', 'k'), true);
    assert.equal(matchGlob('[\u0100-\u2130]', 'K'), true);
});

test('C-1..C-4 & Q-2 & Q-5: normalized direct paths, shell description exclusion, depth limit, batch evidence gate, deterministic audit prune, Windows npm spec, and public exports', async (t) => {
    // C-4: evaluate normalizes dot-segments in direct JS event.paths & matches() validates bad inputs
    const p = policy([
        rule({ id: 'deny-steward', effect: 'deny', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['.steward/policy.json'] }, body: 'No.' })
    ]);
    assert.equal(evaluate(p, { event: 'tool', text: '', tool: 'Write', paths: ['./.steward/policy.json'], sessionId: null }).decision, 'deny');
    assert.equal(evaluate(p, { event: 'tool', text: '', tool: 'Write', paths: ['sub/../.steward/policy.json'], sessionId: null }).decision, 'deny');
    assert.equal(matches(rule(), null), false);
    assert.throws(() => matches({ on: ['prompt'], effect: 'inject', body: 'x', required: false, priority: 1, match: { patternsAny: ['[unclosed'] } }, { event: 'prompt', text: 'hi', tool: null, paths: [], sessionId: null }), { code: 'SCHEMA' });

    // C-2: shell description does not cause false-positive command match
    const { root, temp } = sandbox(t, { plan: plan() });
    const shellEv = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la', description: 'Inspect directory instead of rm -rf /' }
    }, root, 'PreToolUse');
    assert.equal(matchArgGlob(['rm -rf*'], shellEv.text), false);

    // C-3: snapshot refuses excessive nesting depth (>64)
    let deep = path.join(temp, 'deep-proj');
    fs.mkdirSync(deep);
    let cur = deep;
    for (let i = 0; i < 67; i++) {
        cur = path.join(cur, 'd');
        fs.mkdirSync(cur);
    }
    assert.throws(() => snapshot(deep), { code: 'TOO_DEEP' });

    // Q-2: complete goal with multiple evidence hashes validates inside lock
    const vr1 = await runVerification(root);
    const vr2 = await runVerification(root);
    const goalRow = await appendEntry(root, {
        type: 'goal',
        data: { objective: 'Verify batch gate', acceptance: ['pass'], status: 'complete', evidence: [vr1.evidence, vr2.evidence] }
    });
    assert.equal(goalRow.type, 'goal');

    // Q-5: pruneAudit tie-breaks deterministically by ASCII filename when mtime is equal
    const auditDir = path.join(root, '.steward/state/audit');
    fs.mkdirSync(auditDir, { recursive: true });
    for (const name of ['c.json', 'a.json', 'b.json']) {
        const f = path.join(auditDir, name);
        fs.writeFileSync(f, '{}');
        fs.utimesSync(f, new Date(1700000000000), new Date(1700000000000));
    }
    const pruned = pruneAudit(root, { keep: 1 });
    assert.equal(pruned.deleted, 2);
    assert.deepEqual(fs.readdirSync(auditDir), ['c.json']);

    // C-1: resolveSpawnSpec resolves npm/npx via node + *-cli.js when present on win32
    const winBin = path.join(temp, 'win-node');
    const cliBin = path.join(winBin, 'node_modules/npm/bin');
    fs.mkdirSync(cliBin, { recursive: true });
    const fakeNpmCli = path.join(cliBin, 'npm-cli.js');
    fs.writeFileSync(fakeNpmCli, '// fake npm cli');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
    const { resolveSpawnSpec } = await import('../src/verify.mjs');
    assert.equal(typeof resolveSpawnSpec, 'function');
    const spec = resolveSpawnSpec(['npm', 'test'], { PATH: winBin }, winBin);
    assert.equal(spec.file, process.execPath);
    assert.deepEqual(spec.args, [fakeNpmCli, 'test']);

    // Public export parity
    assert.equal(typeof steward.prepareGlobTargets, 'function');
    assert.equal(typeof prepareGlobTargets, 'function');
});
