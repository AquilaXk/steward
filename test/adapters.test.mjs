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
