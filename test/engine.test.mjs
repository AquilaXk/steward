import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, normalizeTool, validateEvent } from '../src/engine.mjs';
import { validatePolicy, validatePlan } from '../src/schema.mjs';
import { event, rule, policy, plan } from './helpers.mjs';
test('literal matching is explicit and case-insensitive', () => { const r = evaluate(policy([rule({ match: { textAny: ['Deploy'] } })]), event('DEPLOY now')); assert.deepEqual(r.emitted, ['example']); });
test('words distinguish npm from pnpm', () => { const p = policy([rule({ match: { wordsAny: ['npm'] } })]); assert.deepEqual(evaluate(p, event('pnpm install')).emitted, []); assert.equal(evaluate(p, event('npm install')).emitted.length, 1); });
test('Unicode words handle Korean and normalized full-width text', () => { const p = policy([rule({ match: { wordsAny: ['검증', 'npm'] } })]); assert.equal(evaluate(p, event('검증 해줘')).emitted.length, 1); assert.equal(evaluate(p, event('ｎｐｍ install')).emitted.length, 1); });
test('no matched rule produces empty context', () => { const r = evaluate(policy([rule({ match: { textAny: ['release'] } })]), event()); assert.equal(r.context, ''); assert.equal(r.bytes, 0); });
test('regression: 4000-byte rules only log the emitted rule', () => { const p = policy([rule({ id: 'first', body: 'x'.repeat(4000) }), rule({ id: 'second', body: 'y'.repeat(4000) })]); const r = evaluate(p, event()); assert.deepEqual(r.emitted, ['first']); assert.deepEqual(r.omitted, [{ id: 'second', reason: 'byte_budget' }]); });
test('regression: oversized first rule does not starve a later short rule', () => { const p = policy([rule({ id: 'a-big', priority: 200, body: 'x'.repeat(6001) }), rule({ id: 'b-small', body: 'short' })]); const r = evaluate(p, event()); assert.deepEqual(r.emitted, ['b-small']); assert.deepEqual(r.omitted, [{ id: 'a-big', reason: 'byte_budget' }]); });
test('required guidance overflow denies instead of silently truncating', () => { const r = evaluate(policy([rule({ body: 'x'.repeat(7000), required: true })]), event()); assert.equal(r.decision, 'deny'); assert.deepEqual(r.emitted, []); assert.equal(r.context, ''); });
test('required guidance reserves budget ahead of optional higher priority rules', () => { const r = evaluate(policy([rule({ id: 'optional', priority: 900, body: 'x'.repeat(3500) }), rule({ id: 'required', priority: 1, required: true, body: 'y'.repeat(3500) })]), event()); assert.deepEqual(r.emitted, ['required']); });
test('denial is independent of byte and count budgets', () => { const r = evaluate(policy([rule({ body: 'x'.repeat(15000) }), rule({ id: 'deny-rule', effect: 'deny', body: 'Stop.', priority: 0 })], { bytes: 128, rules: 1 }), event()); assert.equal(r.decision, 'deny'); assert.deepEqual(r.denied, ['deny-rule']); });
test('UTF-8 budget includes the full rendered envelope', () => { const r = evaluate(policy([rule({ body: '한'.repeat(150) })], { bytes: 500, rules: 2 }), event()); assert.ok(r.bytes <= 500); assert.equal(r.bytes, Buffer.byteLength(r.context)); assert.equal(r.emitted.length, 0); });
test('rule limit produces explicit omissions', () => { const r = evaluate(policy([rule({ id: 'a' }), rule({ id: 'b' })], { bytes: 6000, rules: 1 }), event()); assert.deepEqual(r.omitted, [{ id: 'b', reason: 'rule_limit' }]); });
test('priority ties have deterministic ID order', () => { assert.deepEqual(evaluate(policy([rule({ id: 'z' }), rule({ id: 'a' })]), event()).emitted, ['a', 'z']); });
test('tool aliases share a canonical operation', () => {
    for (const n of ['Edit', 'Write', 'apply_patch'])
        assert.equal(normalizeTool(n), 'file.write');
    for (const n of ['Bash', 'exec_command', 'shell_command'])
        assert.equal(normalizeTool(n), 'shell');
});
test('tool rules stay out of prompt matching', () => { const p = policy([rule({ on: ['tool'], match: { tools: ['Bash'], always: true } })]); assert.equal(evaluate(p, event('Bash')).emitted.length, 0); });
test('path prefixes respect segment boundaries and match case-insensitively', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['Edit'], pathPrefixes: ['memory', '.steward/policy.json'] } })]);
    const e = { ...event(''), event: 'tool', tool: 'apply_patch', paths: ['memory/a.md'] };
    assert.equal(evaluate(p, e).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, paths: ['Memory/a.md'] }).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, paths: ['.Steward/Policy.json'] }).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, paths: ['memory-old/a.md'] }).emitted.length, 0);
});
test('different predicate fields combine with AND', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['shell'], wordsAny: ['npm'], textAny: ['install'] } })]);
    const e = { ...event('npm uninstall'), event: 'tool', tool: 'Bash' };
    assert.equal(evaluate(p, e).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, text: 'pnpm install' }).emitted.length, 0);
});
const badPolicies = [
    ['unsupported version', p => p.version = 2], ['unknown root field', p => p.fallback = true], ['unknown rule field', p => p.rules[0].action = 'block'],
    ['invalid effect', p => p.rules[0].effect = 'blok'], ['tools false', p => p.rules[0].match = { tools: false, textAny: ['x'] }],
    ['empty tools', p => { p.rules[0].on = ['tool']; p.rules[0].match = { tools: [], always: true }; }],
    ['no predicate', p => p.rules[0].match = {}], ['mixed always and content', p => p.rules[0].match = { always: true, textAny: ['x'] }],
    ['regex not supported', p => p.rules[0].match = { patterns: ['(a+)+$'] }], ['duplicate IDs', p => p.rules.push({ ...p.rules[0] })],
    ['invalid priority', p => p.rules[0].priority = NaN], ['zero context budget', p => p.budget.bytes = 0],
    ['tool predicate on prompt', p => p.rules[0].match = { tools: ['Bash'], always: true }],
    ['path traversal', p => { p.rules[0].on = ['tool']; p.rules[0].match = { pathPrefixes: ['../secret'] }; }],
    ['required deny', p => { p.rules[0].effect = 'deny'; p.rules[0].required = true; }]
];
for (const [name, edit] of badPolicies)
    test('strict schema rejects ' + name, () => { const p = policy([rule()]); edit(p); assert.throws(() => validatePolicy(p), { code: 'SCHEMA' }); });
test('empty rule catalog is valid but empty verification is not', () => { assert.doesNotThrow(() => validatePolicy(policy([]))); assert.throws(() => validatePlan({ version: 1, maxAgeSeconds: 1, checks: [] }), { code: 'SCHEMA' }); });
test('repeated command arguments are accepted without shell interpretation', () => { const p = plan(); p.checks[0].argv = ['node', '-e', '', 'same', 'same']; assert.doesNotThrow(() => validatePlan(p)); });
test('oversized event fails validation', () => assert.throws(() => validateEvent(event('x'.repeat(262145))), { code: 'BAD_EVENT' }));
test('punctuation-only word predicates are rejected as dead rules', () => assert.throws(() => validatePolicy(policy([rule({ match: { wordsAny: ['!!!'] } })])), { code: 'SCHEMA' }));
test('literal tool wildcard is rejected instead of silently never matching', () => assert.throws(() => validatePolicy(policy([rule({ on: ['tool'], match: { tools: ['*'], always: true } })])), { code: 'SCHEMA' }));
test('safe glob patterns match command line and CLI flags', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['shell'], patternsAny: ['*--force*'] } })]);
    const e = { ...event('git push --force origin main'), event: 'tool', tool: 'shell' };
    assert.equal(evaluate(p, e).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, text: 'git push --dry-run origin main' }).emitted.length, 0);
});
test('patternsAny matches individual token arguments cleanly', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['shell'], patternsAny: ['-f', '--force'] } })]);
    const e = { ...event('git push -f origin main'), event: 'tool', tool: 'shell' };
    assert.equal(evaluate(p, e).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, text: 'git push -v origin main' }).emitted.length, 0);
});
test('globsAny supports character classes and escapes safely', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['shell'], globsAny: ['rm -[rf]*'] } })]);
    const e = { ...event('rm -rf /tmp/data'), event: 'tool', tool: 'shell' };
    assert.equal(evaluate(p, e).emitted.length, 1);
    assert.equal(evaluate(p, { ...e, text: 'rm -p /tmp/data' }).emitted.length, 0);
});
test('schema rejects malformed pattern brackets', () => {
    assert.throws(() => validatePolicy(policy([rule({ match: { patternsAny: ['[unclosed'] } })])), { code: 'SCHEMA' });
});
test('schema rejects dangling trailing backslash in pattern', () => {
    assert.throws(() => validatePolicy(policy([rule({ match: { patternsAny: ['trailing\\'] } })])), { code: 'SCHEMA' });
});
test('matcher handles escaped brackets in character classes and Unicode code points', async () => {
    const { matchGlob, tokenizeCommand } = await import('../src/matcher.mjs');
    assert.equal(matchGlob(String.raw`[a\]b]`, ']'), true);
    assert.equal(matchGlob(String.raw`[a\]b]`, 'b'), true);
    assert.equal(matchGlob(String.raw`[a\]b]`, 'ab]'), false);
    assert.equal(matchGlob('[🎉]', '🎉'), true);
    assert.equal(matchGlob('?', '🎉'), true);
    assert.equal(matchGlob('*🎉*', 'hello 🎉 world'), true);
    assert.deepEqual(tokenizeCommand('git commit -m ""'), ['git', 'commit', '-m', '']);
    assert.deepEqual(tokenizeCommand("echo '' 'second'"), ['echo', '', 'second']);
});
test('matchGlob does not short-circuit raw equality when pattern contains glob metacharacters or escapes', async () => {
    const { matchGlob, isSafePattern } = await import('../src/matcher.mjs');
    assert.equal(matchGlob('[0-9]', '[0-9]'), false);
    assert.equal(matchGlob('[!a]', '[!a]'), false);
    assert.equal(matchGlob(String.raw`a\*b`, String.raw`a\*b`), false);
    assert.equal(matchGlob(String.raw`a\*b`, 'a*b'), true);
    assert.equal(isSafePattern('[]'), false);
    assert.equal(isSafePattern('[!]'), false);
    assert.equal(isSafePattern('[^]'), false);
    assert.equal(matchGlob('[]', 'a'), false);
    assert.equal(matchGlob('[!]', 'a'), false);
    assert.equal(matchGlob('[^]', 'a'), false);
    assert.throws(() => validatePolicy(policy([rule({ match: { patternsAny: ['[]'] } })])), { code: 'SCHEMA' });
});
test('matchGlob fails closed with GLOB_COMPLEXITY on step budget exhaustion and handles >100k inputs', async () => {
    const { matchGlob } = await import('../src/matcher.mjs');
    const longPrefix = 'a'.repeat(150000) + ' --force';
    assert.equal(matchGlob('*--force*', longPrefix), true);
    const dashAmplification = '-'.repeat(15000) + '--force';
    assert.equal(matchGlob('*--force*', dashAmplification), true);
    assert.throws(() => matchGlob('*a*b*c*', 'xxxx', { maxSteps: 2 }), { code: 'GLOB_COMPLEXITY' });
});
test('tokenizeCommand enforces POSIX single-quote literals and splits unquoted shell operators', async () => {
    const { tokenizeCommand } = await import('../src/matcher.mjs');
    assert.deepEqual(tokenizeCommand(String.raw`git 'push\' --force`), ['git', 'push\\', '--force']);
    assert.deepEqual(tokenizeCommand('git push -f;echo 1'), ['git', 'push', '-f', ';', 'echo', '1']);
    assert.deepEqual(tokenizeCommand('git push --force&&true'), ['git', 'push', '--force', '&&', 'true']);
    assert.deepEqual(tokenizeCommand('(rm -rf /)'), ['(', 'rm', '-rf', '/', ')']);
    const p = policy([rule({ id: 'no-force', effect: 'deny', body: 'No force.', on: ['tool'], match: { tools: ['shell'], patternsAny: ['-f', '--force'] } })]);
    assert.equal(evaluate(p, { ...event(String.raw`git 'push\' --force`), event: 'tool', tool: 'Bash' }).decision, 'deny');
    assert.equal(evaluate(p, { ...event('git push -f;echo 1'), event: 'tool', tool: 'Bash' }).decision, 'deny');
    assert.equal(evaluate(p, { ...event('git push --force&&true'), event: 'tool', tool: 'Bash' }).decision, 'deny');
});
test('normalizeInput preserves file content in text for Write and Edit tool events', async (t) => {
    const { sandbox } = await import('./helpers.mjs');
    const { normalizeInput } = await import('../src/adapters.mjs');
    const { root } = sandbox(t);
    const normWrite = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'src/app.js', content: 'const secret = "PRIVATE_KEY";' }
    }, root, 'PreToolUse');
    assert.deepEqual(normWrite.paths, ['src/app.js']);
    assert.ok(normWrite.text.includes('PRIVATE_KEY'));
    const p = policy([rule({ id: 'no-secret', effect: 'deny', body: 'No secret.', on: ['tool'], match: { tools: ['Write'], patternsAny: ['*PRIVATE_KEY*'] } })]);
    assert.equal(evaluate(p, normWrite).decision, 'deny');
});
test('normalizeTool and normalizeInput handle MultiEdit, NotebookEdit, prototype keys, and multi-slash pathPrefixes', async (t) => {
    const { sandbox } = await import('./helpers.mjs');
    const { normalizeInput } = await import('../src/adapters.mjs');
    const { normalizeTool } = await import('../src/engine.mjs');
    const { root } = sandbox(t);

    assert.equal(normalizeTool('constructor'), 'constructor');
    assert.equal(normalizeTool('__proto__'), '__proto__');
    assert.equal(normalizeTool('MultiEdit'), 'file.write');
    assert.equal(normalizeTool('NotebookEdit'), 'file.write');

    assert.throws(() => normalizeInput('claude', {
        hook_event_name: 'constructor',
        tool_name: 'Bash',
        tool_input: { command: 'ls' }
    }, root), { code: 'BAD_EVENT' });

    const normMulti = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'MultiEdit',
        tool_input: {
            file_path: '.steward/policy.json',
            edits: [
                { old_string: 'allow', new_string: 'deny PRIVATE_KEY_LEAK' }
            ]
        }
    }, root, 'PreToolUse');
    assert.deepEqual(normMulti.paths, ['.steward/policy.json']);
    assert.ok(normMulti.text.includes('PRIVATE_KEY_LEAK'));

    const normNotebook = normalizeInput('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'NotebookEdit',
        tool_input: {
            notebook_path: 'notebooks/analysis.ipynb',
            new_source: 'export SECRET_TOKEN=123'
        }
    }, root, 'PreToolUse');
    assert.deepEqual(normNotebook.paths, ['notebooks/analysis.ipynb']);
    assert.ok(normNotebook.text.includes('SECRET_TOKEN'));

    const p = policy([
        rule({ id: 'protect-steward', effect: 'deny', body: 'Protect steward.', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['.steward///'] } }),
        rule({ id: 'protect-nb', effect: 'deny', body: 'No secret in notebook.', on: ['tool'], match: { tools: ['file.write'], pathPrefixes: ['notebooks///'], patternsAny: ['*SECRET_TOKEN*'] } })
    ]);
    assert.equal(evaluate(p, normMulti).decision, 'deny');
    assert.equal(evaluate(p, normNotebook).decision, 'deny');
});
test('tokenizeCommand elides POSIX backslash-newline line continuations outside single quotes', async () => {
    const { tokenizeCommand } = await import('../src/matcher.mjs');
    assert.deepEqual(tokenizeCommand('git push --fo\\\nrce origin main'), ['git', 'push', '--force', 'origin', 'main']);
    assert.deepEqual(tokenizeCommand('git push --fo\\\r\nrce origin main'), ['git', 'push', '--force', 'origin', 'main']);
    assert.deepEqual(tokenizeCommand('git "pu\\\nsh" "--fo\\\nrce"'), ['git', 'push', '--force']);
    assert.deepEqual(tokenizeCommand("git 'pu\\\nsh' --force"), ['git', 'pu\\\nsh', '--force']);
    const p = policy([rule({ id: 'no-force', effect: 'deny', body: 'No force.', on: ['tool'], match: { tools: ['shell'], patternsAny: ['--force'] } })]);
    assert.equal(evaluate(p, { ...event('git push --fo\\\nrce origin main'), event: 'tool', tool: 'Bash' }).decision, 'deny');
});
