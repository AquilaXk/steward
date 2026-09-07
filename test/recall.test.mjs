import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { sandbox, cli } from './helpers.mjs';
import { appendEntry } from '../src/journal.mjs';

const decision = (statement, supersedes = null) => ({ type: 'decision', data: {
    statement, authority: { kind: 'user', reference: 'task', quote: statement }, supersedes,
} });
test('query bounds output, hides expired and superseded records, and exposes history explicitly', async t => {
    const { root } = sandbox(t);
    const first = await appendEntry(root, decision('Use the old parser'));
    await appendEntry(root, decision('Use the new parser', first.hash));
    await appendEntry(root, { type: 'knowledge', data: { claim: 'Parser assumption', basis: 'assumption', sources: [], expiresAt: '2000-01-01T00:00:00Z' } });
    const result = cli(root, ['journal', 'query', '--text', 'parser', '--limit', '1']);
    assert.equal(result.status, 0, result.stderr);
    const query = JSON.parse(result.stdout);
    assert.equal(query.rows.length, 1);
    assert.equal(query.rows[0].data.statement, 'Use the new parser');
    assert.equal(query.total, 1);
    const history = JSON.parse(cli(root, ['journal', 'query', '--text', 'parser', '--history', '--limit', '1']).stdout);
    assert.equal(history.total, 3);
    assert.equal(history.truncated, true);
    assert.equal(history.rows[0].expired, true);
    assert.equal(cli(root, ['journal', 'query', '--limit', '0']).status, 1);
    const directory = path.join(root, '.steward/state/journal');
    fs.writeFileSync(path.join(directory, fs.readdirSync(directory).sort()[0]), '{}');
    assert.equal(cli(root, ['journal', 'query', '--type', 'knowledge']).status, 1, 'Filtering must not bypass chain validation');
});

test('schedule revisions retain identity, prevent forks and preserve immutable history', async t => {
    const { root } = sandbox(t);
    const entry = { type: 'schedule', data: { id: 'release', title: 'Release', dueAt: '2026-10-01T09:00:00Z', status: 'planned', members: [], supersedes: null } };
    const first = await appendEntry(root, entry);
    const second = await appendEntry(root, { ...entry, data: { ...entry.data, status: 'cancelled', supersedes: first.hash } });
    await assert.rejects(appendEntry(root, { ...entry, data: { ...entry.data, supersedes: first.hash } }), /already been superseded/);
    await assert.rejects(appendEntry(root, { ...entry, data: { ...entry.data, id: 'another', supersedes: second.hash } }), /identity/);
    await assert.rejects(appendEntry(root, entry), /already exists/);
    const result = JSON.parse(cli(root, ['journal', 'query', '--type', 'schedule', '--record-id', 'release']).stdout);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].data.status, 'cancelled');
});
