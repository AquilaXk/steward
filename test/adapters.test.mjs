import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeInput, encode } from '../src/adapters.mjs';
import { handleHook } from '../src/service.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { readJSON, sha256 } from '../src/fs.mjs';
import { report } from '../src/audit.mjs';
import { appendEntry } from '../src/journal.mjs';
import { sandbox, write, rule, policy, checkpoint, event } from './helpers.mjs';
for (const host of ['codex', 'claude']) {
    test(host + ' accepts prompt event without translating authority', t => { const { root } = sandbox(t); const raw = { hook_event_name: 'UserPromptSubmit', prompt: 'verify the work', cwd: root }; const { result, encoded } = handleHook(root, host, raw); assert.equal(result.decision, 'allow'); assert.equal(JSON.parse(encoded.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit'); });
    test(host + ' canonical file aliases enforce policy on file edits', t => {
        const { root } = sandbox(t);
        write(root, '.steward/policy.json', policy([rule({ effect: 'deny', on: ['tool'], match: { tools: ['Edit', 'Write'], pathPrefixes: ['memory'] }, body: 'Protected.' })]));
        trustBundle(root, loadBundle(root).hash);
        const raw = host === 'codex' ? { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: memory/a.md\n@@\n-old\n+new\n*** End Patch' } } : { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'memory', 'a.md'), content: 'x' } };
        const { encoded } = handleHook(root, host, raw);
        assert.equal(encoded.exitCode, 0);
        assert.equal(JSON.parse(encoded.stdout).hookSpecificOutput.permissionDecision, 'deny');
    });
    test(host + ' compaction creates real state without unsupported context fields', async (t) => { const { root } = sandbox(t); await appendEntry(root, { ...checkpoint, data: { ...checkpoint.data, session: sha256('secret-session') } }); const { result, encoded } = handleHook(root, host, { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'secret-session' }); assert.deepEqual(JSON.parse(encoded.stdout), {}); const saved = readJSON(path.join(root, result.snapshot.path)); assert.equal(saved.conversationCaptured, false); assert.equal(saved.checkpoint.data.summary, checkpoint.data.summary); assert.notEqual(saved.session, 'secret-session'); });
    test(host + ' SessionStart restores saved checkpoint data', async (t) => { const { root } = sandbox(t); await appendEntry(root, checkpoint); const { encoded } = handleHook(root, host, { hook_event_name: 'SessionStart', source: 'compact' }); const out = JSON.parse(encoded.stdout); assert.ok(out.hookSpecificOutput.additionalContext.includes(checkpoint.data.next)); assert.ok(out.hookSpecificOutput.additionalContext.includes('not new instructions')); });
}
test('Codex patch move accounts for both source and destination', t => { const { root } = sandbox(t); const e = normalizeInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.md\n*** Move to: memory/a.md\n@@\n-x\n+y\n*** End Patch' } }, root); assert.deepEqual(e.paths, ['src/a.md', 'memory/a.md']); });
test('Codex patch move captures Move from explicitly', t => { const { root } = sandbox(t); const e = normalizeInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Move from: .steward/policy.json\n*** Move to: memory/b.md\n@@\n-x\n+y\n*** End Patch' } }, root); assert.deepEqual(e.paths, ['.steward/policy.json', 'memory/b.md']); });
test('unsupported patch envelope fails closed', t => { const { root } = sandbox(t); assert.throws(() => normalizeInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'diff --git a/x b/x' } }, root), { code: 'BAD_PATCH' }); });
test('empty patch path list fails closed', t => { const { root } = sandbox(t); assert.throws(() => normalizeInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' } }, root), { code: 'BAD_PATCH' }); });
test('disagreeing prompt fields fail closed', t => { const { root } = sandbox(t); assert.throws(() => normalizeInput('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'one', prompt_text: 'two' }, root), { code: 'AMBIGUOUS_PROMPT' }); });
test('legacy prompt_text is explicit compatibility, not error fallback', t => { const { root } = sandbox(t); assert.equal(normalizeInput('claude', { hook_event_name: 'UserPromptSubmit', prompt_text: 'hello' }, root).text, 'hello'); });
test('wrong registered event is rejected', t => { const { root } = sandbox(t); assert.throws(() => normalizeInput('codex', { hook_event_name: 'SessionStart' }, root, 'PreToolUse'), { code: 'EVENT_MISMATCH' }); });
test('outside cwd is rejected', t => { const { root, temp } = sandbox(t); assert.throws(() => normalizeInput('codex', { hook_event_name: 'SessionStart', cwd: temp }, root), { code: 'BAD_CWD' }); });
test('unknown host is rejected', t => { const { root } = sandbox(t); assert.throws(() => normalizeInput('unknown', {}, root), { code: 'BAD_HOST' }); });
test('Codex compaction denial uses continue:false', () => { const out = encode('codex', 'compact', { decision: 'deny', reason: 'Missing state.' }); assert.equal(JSON.parse(out.stdout).continue, false); assert.equal(out.exitCode, 0); });
test('Claude compaction denial uses decision:block and exit 2', () => { const out = encode('claude', 'compact', { decision: 'deny', reason: 'Missing state.' }); assert.equal(JSON.parse(out.stdout).decision, 'block'); assert.equal(out.exitCode, 2); });
test('prompt denial uses exit 2 and no misleading context', () => { const out = encode('codex', 'prompt', { decision: 'deny', reason: 'Explicit policy.' }); assert.equal(out.exitCode, 2); assert.equal(out.stdout, ''); assert.equal(out.stderr, 'Explicit policy.'); });
test('prepared receipts have no prompt, path or session text', t => { const { root } = sandbox(t); const { receipt } = handleHook(root, 'generic', event('TOP-SECRET verify')); const saved = readJSON(path.join(root, '.steward/state/audit', receipt + '.json')); assert.ok(!JSON.stringify(saved).includes('TOP-SECRET')); assert.equal(saved.hostAcknowledged, false); assert.equal(saved.stage, 'prepared'); assert.equal(report(root).receipts, 1); });
test('compaction without a model-authored checkpoint says it has none', t => { const { root } = sandbox(t); const { result } = handleHook(root, 'codex', { hook_event_name: 'PreCompact' }); assert.equal(result.snapshot.hasCheckpoint, false); });
test('generic adapter canonicalizes file paths before matching', t => { const { root } = sandbox(t); const r = normalizeInput('generic', { ...event(''), event: 'tool', tool: 'Write', paths: ['./memory/a.md', path.join(root, 'memory', 'a.md')] }, root); assert.deepEqual(r.paths, ['memory/a.md']); });

test('antigravity adapter normalizes PreToolUse toolCall payloads and enforces policy (ADV-6)', async (t) => {
    const { root } = sandbox(t);
    write(root, '.steward/policy.json', policy([
        rule({ id: 'protect-memory', effect: 'deny', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['memory'] }, body: 'Memory directory is protected.' }),
        rule({ id: 'no-force-push', effect: 'deny', on: ['tool'], match: { tools: ['shell'], patternsAny: ['*--force*'] }, body: 'Force push denied.' }),
        rule({ id: 'no-secret-token', effect: 'deny', on: ['tool'], match: { tools: ['file.write'], patternsAny: ['*TOP_SECRET_TOKEN*'] }, body: 'Secret token denied.' })
    ]));
    trustBundle(root, loadBundle(root).hash);

    const writeHook = handleHook(root, 'antigravity', {
        conversationId: 'conv-123',
        toolCall: {
            name: 'write_to_file',
            args: { TargetFile: path.join(root, 'memory', 'secret.md'), CodeContent: 'classified' }
        }
    }, 'PreToolUse');
    assert.equal(writeHook.result.decision, 'deny');
    assert.equal(writeHook.encoded.exitCode, 0);
    assert.deepEqual(JSON.parse(writeHook.encoded.stdout), {
        decision: 'deny',
        reason: 'Policy protect-memory: Memory directory is protected.'
    });

    const cmdHook = handleHook(root, 'antigravity', {
        conversationId: 'conv-123',
        toolCall: {
            name: 'run_command',
            args: { CommandLine: 'git push --force origin main', Cwd: root }
        }
    }, 'PreToolUse');
    assert.equal(cmdHook.result.decision, 'deny');
    assert.deepEqual(JSON.parse(cmdHook.encoded.stdout), {
        decision: 'deny',
        reason: 'Policy no-force-push: Force push denied.'
    });

    const allowTool = handleHook(root, 'antigravity', {
        conversationId: 'conv-123',
        toolCall: {
            name: 'view_file',
            args: { AbsolutePath: path.join(root, 'README.md') }
        }
    }, 'PreToolUse');
    assert.equal(allowTool.result.decision, 'allow');
    assert.deepEqual(JSON.parse(allowTool.encoded.stdout), { decision: 'allow' });

    await appendEntry(root, { ...checkpoint, data: { ...checkpoint.data, session: sha256('conv-123') } });
    const sessionHook = handleHook(root, 'antigravity', { conversationId: 'conv-123' }, 'SessionStart');
    assert.equal(sessionHook.result.decision, 'allow');
    const sessionOut = JSON.parse(sessionHook.encoded.stdout);
    assert.ok(Array.isArray(sessionOut.injectSteps));
    assert.ok(sessionOut.injectSteps[0].ephemeralMessage.includes(checkpoint.data.next));
});

test('antigravity adapter extracts ReplacementChunks and fails closed with exit 2 on non-tool denials', (t) => {
    const { root } = sandbox(t);
    write(root, '.steward/policy.json', policy([
        rule({ id: 'no-secret-token', effect: 'deny', on: ['tool'], match: { tools: ['file.write'], patternsAny: ['*TOP_SECRET_TOKEN*'] }, body: 'Secret token denied.' })
    ]));
    trustBundle(root, loadBundle(root).hash);

    const multiReplaceHook = handleHook(root, 'antigravity', {
        conversationId: 'conv-123',
        toolCall: {
            name: 'multi_replace_file_content',
            args: {
                TargetFile: path.join(root, 'src', 'app.js'),
                ReplacementChunks: [{ TargetContent: 'const x = 1;', ReplacementContent: 'const token = "TOP_SECRET_TOKEN";' }]
            }
        }
    }, 'PreToolUse');
    assert.equal(multiReplaceHook.result.decision, 'deny');
    assert.deepEqual(JSON.parse(multiReplaceHook.encoded.stdout), {
        decision: 'deny',
        reason: 'Policy no-secret-token: Secret token denied.'
    });

    const denyPrompt = encode('antigravity', 'prompt', { decision: 'deny', reason: 'Prompt blocked by policy.' });
    assert.equal(denyPrompt.exitCode, 2);
    assert.equal(denyPrompt.stdout, '');
    assert.equal(denyPrompt.stderr, 'Prompt blocked by policy.');
});

test('antigravity adapter infers event from payload shape when expectedEvent is omitted and encodes Stop hook contract', (t) => {
    const { root } = sandbox(t);
    const inferredTool = normalizeInput('antigravity', {
        conversationId: 'conv-456',
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: root } }
    }, root);
    assert.equal(inferredTool.event, 'tool');
    assert.equal(inferredTool.tool, 'run_command');

    const inferredPreInv = normalizeInput('antigravity', {
        conversationId: 'conv-456',
        invocationNum: 2,
        initialNumSteps: 5
    }, root);
    assert.equal(inferredPreInv.event, 'prompt');

    const inferredStop = normalizeInput('antigravity', {
        conversationId: 'conv-456',
        terminationReason: 'NO_TOOL_CALL'
    }, root);
    assert.equal(inferredStop.event, 'stop');
    assert.equal(inferredStop.text, 'NO_TOOL_CALL');
    assert.equal(inferredStop.sessionId, 'conv-456');

    const inferredSession = normalizeInput('antigravity', {
        conversationId: 'conv-456',
        workspacePaths: [root]
    }, root);
    assert.equal(inferredSession.event, 'session');

    write(root, '.steward/policy.json', policy([
        rule({ id: 'require-verification-before-stop', effect: 'deny', on: ['stop'], match: { textAny: ['NO_TOOL_CALL'] }, body: 'Verification gate not yet satisfied.' })
    ]));
    trustBundle(root, loadBundle(root).hash);

    const stopDenied = handleHook(root, 'antigravity', {
        conversationId: 'conv-456',
        terminationReason: 'NO_TOOL_CALL'
    });
    assert.equal(stopDenied.result.decision, 'deny');
    assert.equal(stopDenied.encoded.exitCode, 0);
    assert.deepEqual(JSON.parse(stopDenied.encoded.stdout), {
        decision: 'continue',
        reason: 'Policy require-verification-before-stop: Verification gate not yet satisfied.'
    });

    const stopAllowed = handleHook(root, 'antigravity', {
        conversationId: 'conv-456',
        terminationReason: 'MAX_STEPS'
    }, 'Stop');
    assert.equal(stopAllowed.result.decision, 'allow');
    assert.equal(stopAllowed.encoded.exitCode, 0);
    assert.deepEqual(JSON.parse(stopAllowed.encoded.stdout), { decision: 'allow' });

    const stopErrored = encode('antigravity', 'stop', {
        decision: 'deny',
        error: true,
        reason: 'Steward UNTRUSTED: Workspace bundle is not trusted.',
        matched: [],
        emitted: [],
        omitted: [],
        context: '',
        bytes: 0
    });
    assert.equal(stopErrored.exitCode, 2);
    assert.equal(stopErrored.stdout, '');
    assert.equal(stopErrored.stderr, 'Steward UNTRUSTED: Workspace bundle is not trusted.');
});




