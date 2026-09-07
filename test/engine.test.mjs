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
test('path prefixes respect segment boundaries', () => { const p = policy([rule({ on: ['tool'], match: { tools: ['Edit'], pathPrefixes: ['memory'] } })]); const e = { ...event(''), event: 'tool', tool: 'apply_patch', paths: ['memory/a.md'] }; assert.equal(evaluate(p, e).emitted.length, 1); assert.equal(evaluate(p, { ...e, paths: ['memory-old/a.md'] }).emitted.length, 0); });
test('different predicate fields combine with AND', () => {
    const p = policy([rule({ on: ['tool'], match: { tools: ['shell'], wordsAny: ['npm'], textAny: ['install'] } })]);
    const e = { ...event('npm uninstall'), event: 'tool', tool: 'Bash' };
    assert.equal(evaluate(p, e).emitted.length, 1); // explicit substring semantics of textAny
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
