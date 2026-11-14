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
    assert.equal(Object.isFrozen(queryJournal(root).rows[0]), true);
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

test('byHash, metaByHash, and null-session checkpoint index support O(1) lookups', async (t) => {
    const { latestCheckpoint } = await import('../src/journal.mjs');
    const { toSessionHash } = await import('../src/fs.mjs');
    const { root } = sandbox(t);

    const decision = await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Use O(1) hash lookup map',
            authority: { kind: 'user', reference: 'task', quote: 'index by hash' },
            supersedes: null,
            tags: ['perf', 'index']
        }
    });
    const knowledge = await appendEntry(root, {
        type: 'knowledge',
        data: {
            claim: 'Precompute metadata per row',
            basis: 'observation',
            sources: [],
            expiresAt: '2030-01-01T00:00:00.000Z',
            tags: ['meta']
        }
    });
    const ckptNull = await appendEntry(root, {
        type: 'checkpoint',
        data: {
            summary: 'Unscoped checkpoint',
            next: 'Verify null session bucket',
            blockers: []
        }
    });
    const sessionHash = toSessionHash('session-alpha');
    const ckptSession = await appendEntry(root, {
        type: 'checkpoint',
        data: {
            summary: 'Scoped checkpoint',
            next: 'Verify session bucket',
            blockers: [],
            session: sessionHash
        }
    });

    const { cache } = syncJournalCache(root);
    assert.equal(cache.index.byHash.get(decision.hash)?.id, decision.id);
    const meta = cache.index.metaByHash.get(knowledge.hash);
    assert.ok(meta);
    assert.equal(Number.isFinite(meta.timeMs), true);
    assert.equal(meta.expiresAtMs, Date.parse('2030-01-01T00:00:00.000Z'));
    assert.equal(meta.searchText.includes('precompute metadata'), true);
    assert.equal(meta.tagSet.has('meta'), true);

    assert.equal(cache.index.bySession.get(null)?.length, 1);
    assert.equal(cache.index.bySession.get(null)[0].hash, ckptNull.hash);
    assert.equal(latestCheckpoint(root, null)?.hash, ckptNull.hash);
    assert.equal(latestCheckpoint(root, 'session-alpha')?.hash, ckptSession.hash);
});

test('multi-index bucket intersection and reverse early-exit limit preserve total and ordering', async (t) => {
    const { root } = sandbox(t);
    const first = await appendEntry(root, {
        type: 'schedule',
        data: {
            id: 'sched-intersect',
            title: 'Phase 1 milestone',
            dueAt: '2026-12-01T00:00:00.000Z',
            status: 'planned',
            members: ['agent'],
            supersedes: null,
            tags: ['release', 'v2']
        }
    });
    await appendEntry(root, {
        type: 'decision',
        data: {
            statement: 'Unrelated decision with release tag',
            authority: { kind: 'user', reference: 'task', quote: 'keep separate' },
            supersedes: null,
            tags: ['release']
        }
    });
    const second = await appendEntry(root, {
        type: 'schedule',
        data: {
            id: 'sched-intersect',
            title: 'Phase 2 milestone',
            dueAt: '2026-12-10T00:00:00.000Z',
            status: 'staged',
            members: ['agent'],
            supersedes: first.hash,
            tags: ['release', 'v2']
        }
    });

    const res = queryJournal(root, {
        type: 'schedule',
        tag: 'release',
        recordId: 'sched-intersect',
        history: true,
        limit: 1
    });
    assert.equal(res.total, 2);
    assert.equal(res.truncated, true);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].hash, second.hash);

    const disjoint = queryJournal(root, {
        type: 'schedule',
        tag: 'missing-tag',
        recordId: 'sched-intersect',
        history: true
    });
    assert.equal(disjoint.total, 0);
    assert.equal(disjoint.rows.length, 0);
});

test('ASCII bitmap char classes, Unicode char classes, and prepareGlobTargets match identically', async () => {
    const { matchGlob, matchArgGlob, prepareGlobTargets } = await import('../src/matcher.mjs');

    assert.equal(matchGlob('file-[a-z0-9].mjs', 'file-7.mjs'), true);
    assert.equal(matchGlob('file-[a-z0-9].mjs', 'file-_.mjs'), false);
    assert.equal(matchGlob('file-[!0-9].mjs', 'file-a.mjs'), true);
    assert.equal(matchGlob('file-[!0-9].mjs', 'file-5.mjs'), false);
    assert.equal(matchGlob('문서-[가-힣].md', '문서-가.md'), true);
    assert.equal(matchGlob('문서-[!가-힣].md', '문서-1.md'), true);
    assert.equal(matchGlob('문서-[!가-힣].md', '문서-나.md'), false);

    const cmd = 'git push --force-with-lease origin main && echo "done"';
    const preparedTargets = prepareGlobTargets(cmd, false);
    const matchingPatterns = ['git *[a-z0-9_-]* --force*', 'npm *'];
    const nonMatchingPatterns = ['docker *[0-9a-f]*', 'cargo *'];

    assert.equal(
        matchArgGlob(matchingPatterns, cmd, { preparedTargets }),
        matchArgGlob(matchingPatterns, cmd)
    );
    assert.equal(matchArgGlob(matchingPatterns, cmd, { preparedTargets }), true);
    assert.equal(
        matchArgGlob(nonMatchingPatterns, cmd, { preparedTargets }),
        matchArgGlob(nonMatchingPatterns, cmd)
    );
    assert.equal(matchArgGlob(nonMatchingPatterns, cmd, { preparedTargets }), false);
});

test('journal search indexes values only, multi-word bitsets (>64 rows) intersect accurately, and write-through append updates cache', async (t) => {
    const { root } = sandbox(t);
    const { toSessionHash } = await import('../src/fs.mjs');
    const targetSessHash = toSessionHash('sess-alpha');
    const otherSessHash = toSessionHash('sess-beta');

    for (let i = 0; i < 75; i++) {
        if (i % 3 === 0) {
            await appendEntry(root, {
                type: 'decision',
                data: {
                    statement: `Use shard ${i}`,
                    authority: { kind: 'user', reference: 'qa', quote: 'approved' },
                    supersedes: null,
                    tags: ['perf', `mod-${i % 2}`]
                }
            });
        } else {
            await appendEntry(root, {
                type: 'checkpoint',
                data: {
                    summary: `Checkpoint batch ${i}`,
                    next: `Step ${i + 1}`,
                    blockers: [],
                    session: i % 2 === 0 ? targetSessHash : otherSessHash,
                    tags: [i % 4 === 0 ? 'perf' : 'core']
                }
            });
        }
    }

    assert.equal(queryJournal(root, { text: 'statement' }).total, 0);
    assert.equal(queryJournal(root, { text: 'authority' }).total, 0);

    const multi = queryJournal(root, {
        type: 'checkpoint',
        tag: 'perf',
        sessionId: 'sess-alpha',
        limit: 5
    });
    assert.equal(multi.rows.length, 5);
    assert.equal(multi.truncated, true);
    assert.ok(multi.rows[0].seq > multi.rows[4].seq);
    for (const r of multi.rows) {
        assert.equal(r.type, 'checkpoint');
        assert.equal(r.data.session, targetSessHash);
        assert.ok(r.data.tags.includes('perf'));
    }

    await appendEntry(root, {
        type: 'checkpoint',
        data: {
            summary: 'Write-through live entry',
            next: 'Verify immediate visibility',
            blockers: [],
            session: targetSessHash,
            tags: ['live']
        }
    });
    const live = queryJournal(root, { type: 'checkpoint', tag: 'live', sessionId: 'sess-alpha' });
    assert.equal(live.total, 1);
    assert.equal(live.rows[0].data.summary, 'Write-through live entry');
});


