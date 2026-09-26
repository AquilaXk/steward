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
});
