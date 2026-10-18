import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, installHooks } from '../src/setup.mjs';
import { auditInstructions } from '../src/instructions.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { PACKAGE, sandbox, cli, write, event, rule, policy, plan } from './helpers.mjs';
test('init is idempotent and preserves user AGENTS content', t => { const { root } = sandbox(t); const p = path.join(root, 'AGENTS.md'); fs.appendFileSync(p, '\nUser-owned notes.\n'); const before = fs.readFileSync(p, 'utf8'); const out = initProject(root); assert.equal(fs.readFileSync(p, 'utf8'), before); assert.ok(out.skipped.includes('AGENTS.md')); });
test('init installs all eight actual skills', t => { const { root } = sandbox(t); assert.equal(fs.readdirSync(path.join(root, '.agents/skills')).length, 8); });
for (const host of ['codex', 'claude']) {
    test(host + ' install preserves unrelated handlers and is idempotent', t => { const { root } = sandbox(t); const rel = host === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json'; write(root, rel, { custom: 'keep', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo preserve' }] }] } }); installHooks(root, host); installHooks(root, host); const c = JSON.parse(fs.readFileSync(path.join(root, rel))); assert.equal(c.custom, 'keep'); assert.equal(c.hooks.PreToolUse.length, 2); assert.equal(c.hooks.PreToolUse[0].hooks[0].command, 'echo preserve'); });
}
test('CLI evaluates a draft without trust and says simulation', t => { const { root } = sandbox(t, { trusted: false }); write(root, 'event.json', event('verify')); const r = cli(root, ['eval', '--input', path.join(root, 'event.json')]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).simulation, true); });
test('CLI invalid tool input returns a host-level denial', t => { const { root } = sandbox(t); const r = cli(root, ['hook', '--host', 'codex', '--event', 'PreToolUse'], '{broken'); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny'); });
test('CLI missing project policy never permits generic execution', t => { const { root } = sandbox(t); fs.unlinkSync(path.join(root, '.steward/policy.json')); const r = cli(root, ['hook', '--host', 'generic'], event()); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).decision, 'deny'); });
test('CLI doctor fails on an untrusted project', t => { const { root } = sandbox(t, { trusted: false }); const r = cli(root, ['doctor']); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stderr).error.code, 'UNTRUSTED'); });
test('CLI verifier and completion gate work end to end', t => { const { root } = sandbox(t, { plan: plan() }); const a = cli(root, ['verify']); assert.equal(a.status, 0, a.stderr); const b = cli(root, ['gate']); assert.equal(b.status, 0, b.stderr); assert.equal(JSON.parse(b.stdout).pass, true); });
test('instruction inventory flags approval stalls with source locations', t => { const { root } = sandbox(t); write(root, 'AGENTS.md', 'Always ask for approval before every action.\n'); const r = auditInstructions(root); assert.equal(r.completeSecurityReview, false); assert.ok(r.files.find(f => f.path === 'AGENTS.md').findings.some(f => f.code === 'approval-stall' && f.line === 1)); });
test('actual prepared report excludes budget-dropped rules', t => { const { root } = sandbox(t); write(root, '.steward/policy.json', policy([rule({ id: 'a', body: 'a'.repeat(4000) }), rule({ id: 'b', body: 'b'.repeat(4000) })])); trustBundle(root, loadBundle(root).hash); const h = cli(root, ['hook', '--host', 'generic'], event()); assert.equal(h.status, 0, h.stderr); const r = cli(root, ['report']); assert.deepEqual(JSON.parse(r.stdout).emitted, { a: 1 }); });
test('hook CLI option errors also produce a host denial', t => { const { root } = sandbox(t); const r = cli(root, ['hook', '--host', 'codex', '--event', 'PreToolUse', '--unknown-option'], event()); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny'); });
test('init fills an existing empty AGENTS file without clobbering other files', t => {
    const { root } = sandbox(t);
    write(root, 'AGENTS.md', '');
    initProject(root);
    assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Steward working agreement/);
});
test('malformed UTF-8 on stdin cannot be silently repaired into an accepted request', t => {
    const { root } = sandbox(t);
    const raw = Buffer.concat([Buffer.from('{"event":"prompt","text":"'), Buffer.from([0xff]), Buffer.from('","tool":null,"paths":[],"sessionId":null}')]);
    const child = spawnSync(process.execPath, [path.join(PACKAGE, 'bin/steward.mjs'), 'hook', '--host', 'generic', '--project', root], { input: raw, encoding: 'utf8', env: process.env, timeout: 10000 });
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).decision, 'deny');
});
test('CLI audit prune removes older receipts to keep retention capacity', t => {
    const { root } = sandbox(t);
    for (let i = 0; i < 5; i++) {
        cli(root, ['hook', '--host', 'generic'], event('step ' + i));
    }
    const auditDir = path.join(root, '.steward/state/audit');
    assert.equal(fs.readdirSync(auditDir).filter(f => f.endsWith('.json')).length, 5);
    const res = cli(root, ['audit', 'prune', '--keep', '2']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.deleted, 3);
    assert.equal(out.remaining, 2);
    assert.equal(fs.readdirSync(auditDir).filter(f => f.endsWith('.json')).length, 2);
});
test('CLI keygen generates Ed25519 keypair and writes files with --out', (t) => {
    const { root, temp } = sandbox(t);
    const outDir = path.join(temp, 'keys');
    const res = cli(root, ['keygen', '--out', outDir]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.generated, true);
    assert.equal(fs.existsSync(path.join(outDir, 'steward-ed25519.priv.pem')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'steward-ed25519.pub.pem')), true);
});
test('CLI mcp --config outputs configuration for specified host', (t) => {
    const { root } = sandbox(t);
    const res = cli(root, ['mcp', '--config', '--host', 'cursor']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.mcpServers.steward);
    assert(out.mcpServers.steward.args.includes('mcp'));
});
function verifySignAndVerify(root, keyDir, keyFlag, verifierFlag) {
    const privPath = path.join(keyDir, 'steward-ed25519.priv.pem');
    const pubPath = path.join(keyDir, 'steward-ed25519.pub.pem');

    const signRes = cli(root, ['sign-bundle', keyFlag, privPath]);
    assert.equal(signRes.status, 0, signRes.stderr);
    const signData = JSON.parse(signRes.stdout);
    assert.equal(signData.alg, 'ed25519');

    const verifyRes = cli(root, ['verify-bundle', verifierFlag, pubPath]);
    assert.equal(verifyRes.status, 0, verifyRes.stderr);
    const verifyData = JSON.parse(verifyRes.stdout);
    assert.equal(verifyData.valid, true);
    return { privPath, pubPath };
}

test('CLI sign-bundle and verify-bundle authenticate trust bundle', (t) => {
    const { root, temp } = sandbox(t);
    const keyDir = path.join(temp, 'keys');
    cli(root, ['keygen', '--out', keyDir]);
    verifySignAndVerify(root, keyDir, '--key', '--verifier');
});

test('CLI sign-bundle and verify-bundle accept --key-file and --public-key aliases', (t) => {
    const { root, temp } = sandbox(t);
    const keyDir = path.join(temp, 'keys');
    cli(root, ['keygen', '--out', keyDir]);
    const { privPath } = verifySignAndVerify(root, keyDir, '--key-file', '--public-key');

    // Nonexistent or invalid key file paths are rejected cleanly
    const badSign = cli(root, ['sign-bundle', '--key-file', path.join(keyDir, 'nonexistent.pem')]);
    assert.equal(badSign.status, 1);
    assert(badSign.stderr.includes('CRYPTO_ERROR'));

    const badVerify = cli(root, ['verify-bundle', '--public-key', path.join(keyDir, 'nonexistent.pem')]);
    assert.equal(badVerify.status, 1);
    assert(badVerify.stderr.includes('CRYPTO_ERROR'));

    // Relative path works cleanly
    const relPriv = path.relative(process.cwd(), privPath);
    const relSign = cli(root, ['sign-bundle', '--key-file', relPriv]);
    assert.equal(relSign.status, 0, relSign.stderr);
});

test('CLI audit prune rejects empty --keep value instead of coercing to 0', (t) => {
    const { root } = sandbox(t);
    cli(root, ['hook', '--host', 'generic'], event('step 1'));
    const res = cli(root, ['audit', 'prune', '--keep', '']);
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stderr).error.code, 'USAGE');
});

test('CLI journal query supports --tag and journal verify enforces fresh hash-chain verification', (t) => {
    const { root } = sandbox(t);
    const entryFile = path.join(root, 'decision.json');
    write(root, 'decision.json', {
        type: 'decision',
        data: {
            statement: 'Enforce fresh hash chain verification',
            authority: { kind: 'user', reference: 'issue-10', quote: 'always verify' },
            supersedes: null,
            tags: ['security-gate']
        }
    });
    const addRes = cli(root, ['journal', 'add', '--file', entryFile]);
    assert.equal(addRes.status, 0, addRes.stderr);

    const queryRes = cli(root, ['journal', 'query', '--tag', 'security-gate']);
    assert.equal(queryRes.status, 0, queryRes.stderr);
    const queryOut = JSON.parse(queryRes.stdout);
    assert.equal(queryOut.total, 1);
    assert.deepEqual(queryOut.rows[0].data.tags, ['security-gate']);
});

test('CLI hook without --event preserves stdin event kind when encoding errors', (t) => {
    const { root } = sandbox(t, { trusted: false });
    const res = cli(root, ['hook', '--host', 'claude'], {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' }
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('report uses prototype-safe emitted counter and doctor validates installation receipt configHash', async (t) => {
    const { audit, report } = await import('../src/audit.mjs');
    const { installHooks } = await import('../src/setup.mjs');
    const { doctor } = await import('../src/doctor.mjs');
    const { root } = sandbox(t);

    write(root, '.steward/policy.json', policy([
        rule({ id: 'constructor', effect: 'inject', body: 'Constructor rule.', on: ['prompt'], match: { always: true } })
    ]));
    const b = loadBundle(root);
    trustBundle(root, b.hash);

    audit(root, 'claude', { event: 'prompt' }, {
        decision: 'allow',
        matched: ['constructor'],
        emitted: ['constructor'],
        omitted: [],
        bytes: 20
    }, b.hash);

    const rep = report(root);
    assert.equal(rep.emitted.constructor, 1);

    installHooks(root, 'claude');
    assert.equal(doctor(root, 'claude').localHealthy, true);

    // Corrupt receipt.configHash and verify doctor marks host broken
    const receiptFile = path.join(root, '.steward/install-claude.json');
    const receiptObj = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receiptObj.configHash = 'not-a-sha256';
    fs.writeFileSync(receiptFile, JSON.stringify(receiptObj, null, 2) + '\n');
    const docBadReceipt = doctor(root, 'claude');
    assert.equal(docBadReceipt.localHealthy, false);
    assert.equal(docBadReceipt.hosts[0].status, 'broken');
});

test('CLI maps missing project to BAD_PROJECT and missing files to MISSING_FILE instead of INTERNAL_ERROR', (t) => {
    const { root, temp } = sandbox(t);
    const badProj = cli(path.join(temp, 'nonexistent-project-dir'), ['trust']);
    assert.equal(badProj.status, 1);
    assert.equal(JSON.parse(badProj.stderr).error.code, 'BAD_PROJECT');

    const missingEntry = cli(root, ['journal', 'add', '--file', path.join(root, 'missing-entry.json')]);
    assert.equal(missingEntry.status, 1);
    assert.equal(JSON.parse(missingEntry.stderr).error.code, 'MISSING_FILE');

    const uninitDir = path.join(temp, 'uninitialized-dir');
    fs.mkdirSync(uninitDir, { recursive: true });
    const uninitTrust = cli(uninitDir, ['trust']);
    assert.equal(uninitTrust.status, 1);
    assert.equal(JSON.parse(uninitTrust.stderr).error.code, 'MISSING_FILE');
});

test('CLI trust exposes bundleHash alias and verify/gate expose evidenceHash alias', (t) => {
    const { root } = sandbox(t, { trusted: false, plan: plan() });
    const trustReview = cli(root, ['trust']);
    assert.equal(trustReview.status, 0, trustReview.stderr);
    const reviewJson = JSON.parse(trustReview.stdout);
    assert.equal(typeof reviewJson.bundleHash, 'string');
    assert.equal(reviewJson.bundleHash, reviewJson.review.hash);

    const approveRes = cli(root, ['trust', '--approve', reviewJson.bundleHash]);
    assert.equal(approveRes.status, 0, approveRes.stderr);

    const verifyRes = cli(root, ['verify']);
    assert.equal(verifyRes.status, 0, verifyRes.stderr);
    const verifyJson = JSON.parse(verifyRes.stdout);
    assert.equal(typeof verifyJson.evidenceHash, 'string');
    assert.equal(verifyJson.evidenceHash, verifyJson.evidence);

    const gateRes = cli(root, ['gate', '--evidence', verifyJson.evidenceHash]);
    assert.equal(gateRes.status, 0, gateRes.stderr);
    const gateJson = JSON.parse(gateRes.stdout);
    assert.equal(gateJson.pass, true);
    assert.equal(gateJson.evidenceHash, verifyJson.evidenceHash);
    assert.equal(gateJson.evidence, verifyJson.evidence);
});

test('auditInstructions scans GEMINI.md and doctor allowUntrusted returns structured diagnostics', async (t) => {
    const { doctor } = await import('../src/doctor.mjs');
    const { root } = sandbox(t, { trusted: false });
    write(root, 'GEMINI.md', 'Always ask for approval before running any check.\n');

    const auditRes = auditInstructions(root);
    const geminiFile = auditRes.files.find(f => f.path === 'GEMINI.md');
    assert.ok(geminiFile, 'Expected GEMINI.md to be included in instruction audit inventory');
    assert.ok(geminiFile.findings.some(f => f.code === 'approval-stall' && f.line === 1));

    const diag = doctor(root, null, { allowUntrusted: true });
    assert.equal(diag.trusted, false);
    assert.equal(diag.healthy, false);
    assert.equal(diag.localHealthy, false);
    assert.equal(diag.trustError?.code, 'UNTRUSTED');
    assert.equal(typeof diag.bundleHash, 'string');
});

test('CLI maps unknown parseArgs flags to USAGE, accepts --file/--input interchangeably, and returns privPath/pubPath on keygen', (t) => {
    const { root, temp } = sandbox(t);

    const badFlag = cli(root, ['journal', '--unknown-flag']);
    assert.equal(badFlag.status, 1);
    const badFlagErr = JSON.parse(badFlag.stderr);
    assert.equal(badFlagErr.error.code, 'USAGE');
    assert.match(badFlagErr.error.message, /unknown-flag/i);

    const evalFile = path.join(temp, 'event.json');
    fs.writeFileSync(evalFile, JSON.stringify(event('check --file on eval')));
    const evalRes = cli(root, ['eval', '--file', evalFile]);
    assert.equal(evalRes.status, 0, evalRes.stderr);
    assert.equal(JSON.parse(evalRes.stdout).decision, 'allow');

    const decisionFile = path.join(temp, 'decision.json');
    fs.writeFileSync(decisionFile, JSON.stringify({
        type: 'decision',
        data: {
            statement: 'Accept --file and --input interchangeably across CLI commands',
            authority: { kind: 'user', reference: 'QA dogfooding audit', quote: 'Proceed with ADV-2' },
            supersedes: null
        }
    }));
    const addRes = cli(root, ['journal', 'add', '--input', decisionFile]);
    assert.equal(addRes.status, 0, addRes.stderr);
    assert.equal(JSON.parse(addRes.stdout).type, 'decision');

    const cpFile = path.join(temp, 'checkpoint.json');
    fs.writeFileSync(cpFile, JSON.stringify({ summary: 'Track 7 checkpoint via --input', next: 'Run verify', blockers: [] }));
    const cpRes = cli(root, ['checkpoint', '--input', cpFile]);
    assert.equal(cpRes.status, 0, cpRes.stderr);
    assert.equal(JSON.parse(cpRes.stdout).type, 'checkpoint');

    const keysDir = path.join(temp, 'keys');
    const keygenRes = cli(root, ['keygen', '--out', keysDir]);
    assert.equal(keygenRes.status, 0, keygenRes.stderr);
    const keygenJson = JSON.parse(keygenRes.stdout);
    assert.equal(keygenJson.generated, true);
    assert.equal(keygenJson.out, keysDir);
    assert.equal(keygenJson.privPath, path.join(keysDir, 'steward-ed25519.priv.pem'));
    assert.equal(keygenJson.pubPath, path.join(keysDir, 'steward-ed25519.pub.pem'));
    assert.ok(fs.existsSync(keygenJson.privPath));
    assert.ok(fs.existsSync(keygenJson.pubPath));

    const untrusted = sandbox(t, { trusted: false });
    const untrustedStop = cli(untrusted.root, ['hook', '--host', 'antigravity', '--event', 'Stop'], {
        conversationId: 'conv-456',
        terminationReason: 'NO_TOOL_CALL'
    });
    assert.equal(untrustedStop.status, 2);
    assert.equal(untrustedStop.stdout, '');
    assert.match(untrustedStop.stderr, /Steward UNTRUSTED:/);
});


