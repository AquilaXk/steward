import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { appendEntry, queryJournal, readJournal } from '../src/journal.mjs';
import { syncJournalCache, invalidateJournalCache } from '../src/index-cache.mjs';

test('journal index cache populates and accelerates queries', async (t) => {
    const { root } = sandbox(t);
    await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Adopt indexed metadata cache',
            authority: { kind: 'user', reference: 'task', quote: 'index metadata' },
            supersedes: null
        }
    });
    await appendEntry(root, {
        type: 'knowledge',
        data: {
            claim: 'Indexing reduces disk reads',
            basis: 'observation',
            sources: [],
            expiresAt: null
        }
    });

    // Initial sync
    const firstSync = syncJournalCache(root);
    assert.equal(firstSync.rows.length, 2);
    assert.equal(firstSync.cache.files.length, 2);
    assert.equal(firstSync.cache.index.byType.get('decision').length, 1);
    assert.equal(firstSync.cache.index.byType.get('knowledge').length, 1);

    // Fast query by type uses index
    const decisionQuery = queryJournal(root, { type: 'decision' });
    assert.equal(decisionQuery.total, 1);
    assert.equal(decisionQuery.rows[0].data.statement, 'Adopt indexed metadata cache');

    // Add 3rd record
    await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Second decision',
            authority: { kind: 'user', reference: 'task', quote: 'second quote' },
            supersedes: null
        }
    });

    const secondSync = syncJournalCache(root);
    assert.equal(secondSync.rows.length, 3);
    assert.equal(secondSync.cache.index.byType.get('decision').length, 2);

    // Invalidation resets cleanly
    invalidateJournalCache(root);
    const freshRows = readJournal(root, { fresh: true });
    assert.equal(freshRows.length, 3);

    // Query non-existent type returns 0 matches cleanly
    const goalQuery = queryJournal(root, { type: 'goal' });
    assert.equal(goalQuery.total, 0);
    assert.equal(goalQuery.rows.length, 0);

    // Timestamp filtering: since & until
    const now = Date.now();
    const futureQuery = queryJournal(root, { since: now + 10000 });
    assert.equal(futureQuery.total, 0);

    const pastQuery = queryJournal(root, { until: now + 10000 });
    assert.equal(pastQuery.total, 3);
});

test('journal schema accepts tags and queryJournal filters by tag and smallest candidate index', async (t) => {
    const { root } = sandbox(t);
    await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Tag-enabled decision',
            authority: { kind: 'user', reference: 'task', quote: 'support tags' },
            supersedes: null,
            tags: ['security', 'v1']
        }
    });
    const matched = queryJournal(root, { tag: 'security' });
    assert.equal(matched.total, 1);
    assert.equal(matched.rows[0].data.statement, 'Tag-enabled decision');

    const missing = queryJournal(root, { tag: 'nonexistent' });
    assert.equal(missing.total, 0);
});

test('cached journal rows and array are immutable against caller mutation', async (t) => {
    const { root } = sandbox(t);
    await appendEntry(root, {
        type: 'knowledge',
        data: {
            claim: 'Immutable row claim',
            basis: 'observation',
            sources: [],
            expiresAt: null
        }
    });
    const rows = readJournal(root);
    assert.equal(rows.length, 1);
    assert.throws(() => {
        rows[0].data.claim = 'Mutated';
    }, TypeError);
    rows.pop();
    assert.equal(readJournal(root).length, 1);
});

test('queryJournal rejects malformed since/until timestamps and preserves all schedule revisions for recordId + history', async (t) => {
    const { root } = sandbox(t);
    assert.throws(() => queryJournal(root, { since: 'not-a-timestamp' }), { code: 'BAD_QUERY' });
    assert.throws(() => queryJournal(root, { until: 'invalid-date' }), { code: 'BAD_QUERY' });

    const first = await appendEntry(root, {
        type: 'schedule',
        data: {
            id: 'rel-1',
            title: 'Initial release schedule',
            dueAt: '2026-12-01T00:00:00.000Z',
            status: 'planned',
            members: [],
            supersedes: null
        }
    });
    await appendEntry(root, {
        type: 'schedule',
        data: {
            id: 'rel-1',
            title: 'Updated release schedule',
            dueAt: '2026-12-02T00:00:00.000Z',
            status: 'staged',
            members: [],
            supersedes: first.hash
        }
    });

    const activeOnly = queryJournal(root, { recordId: 'rel-1', history: false });
    assert.equal(activeOnly.total, 1);
    assert.equal(activeOnly.rows[0].data.status, 'staged');

    const fullHistory = queryJournal(root, { recordId: 'rel-1', history: true });
    assert.equal(fullHistory.total, 2);
});

test('validatePlan rejects glob wildcards in exclude, snapshot strips trailing slash, and completionGate forces fresh hash verification', async (t) => {
    const { validatePlan } = await import('../src/schema.mjs');
    const { snapshot } = await import('../src/fs.mjs');
    const { runVerification, completionGate } = await import('../src/verify.mjs');
    const { plan: makePlan } = await import('./helpers.mjs');
    const fs = await import('node:fs');
    const path = await import('node:path');

    assert.throws(
        () => validatePlan({ ...makePlan(), exclude: ['dist/*'] }),
        { code: 'SCHEMA' }
    );

    const { root } = sandbox(t, { plan: makePlan() });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'console.log(1);');
    const snapWithSlash = snapshot(root, ['dist/']);
    const snapWithoutSlash = snapshot(root, ['dist']);
    assert.equal(snapWithSlash.hash, snapWithoutSlash.hash);

    const report = await runVerification(root);
    assert.equal(report.allPassed, true);
    // Warm the cache
    readJournal(root);

    // Tamper with the journal file payload on disk while preserving exact byte size and mtime
    const journalDir = path.join(root, '.steward/state/journal');
    const file = path.join(journalDir, fs.readdirSync(journalDir)[0]);
    const statBefore = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const tampered = raw.replace('"platform": "' + process.platform + '"', '"platform": "' + 'x'.repeat(process.platform.length) + '"');
    assert.notEqual(tampered, raw);
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(raw));
    fs.writeFileSync(file, tampered);
    fs.utimesSync(file, statBefore.atime, statBefore.mtime);

    assert.throws(() => completionGate(root, report.evidence), { code: 'JOURNAL_CORRUPT' });
});

