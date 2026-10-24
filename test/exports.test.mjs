import test from 'node:test';
import assert from 'node:assert/strict';
import * as steward from '../src/index.mjs';

test('library entrypoint exports all core functions and constants', () => {
    assert.equal(typeof steward.VERSION, 'string');
    assert.equal(typeof steward.evaluate, 'function');
    assert.equal(typeof steward.matches, 'function');
    assert.equal(typeof steward.normalizeTool, 'function');
    assert.equal(typeof steward.relativePath, 'function');
    assert.equal(typeof steward.validateEvent, 'function');

    assert.equal(typeof steward.matchGlob, 'function');
    assert.equal(typeof steward.matchArgGlob, 'function');
    assert.equal(typeof steward.tokenizeCommand, 'function');
    assert.equal(typeof steward.isSafePattern, 'function');

    assert.equal(typeof steward.validatePolicy, 'function');
    assert.equal(typeof steward.validatePlan, 'function');
    assert.equal(typeof steward.validateEntry, 'function');
    assert.equal(typeof steward.validateVerification, 'function');
    assert.equal(typeof steward.validateJournalRow, 'function');
    assert.ok(Array.isArray(steward.RECORD_TYPES));

    assert.equal(typeof steward.appendEntry, 'function');
    assert.equal(typeof steward.readJournal, 'function');
    assert.equal(typeof steward.journalHead, 'function');
    assert.equal(typeof steward.queryJournal, 'function');
    assert.equal(typeof steward.latestCheckpoint, 'function');
    assert.equal(typeof steward.saveCompaction, 'function');
    assert.equal(typeof steward.syncJournalCache, 'function');
    assert.equal(typeof steward.queryJournalIndexed, 'function');
    assert.equal(typeof steward.invalidateJournalCache, 'function');

    assert.equal(typeof steward.runVerification, 'function');
    assert.equal(typeof steward.completionGate, 'function');
    assert.equal(typeof steward.resolveCommand, 'function');

    assert.equal(typeof steward.loadBundle, 'function');
    assert.equal(typeof steward.trustBundle, 'function');
    assert.equal(typeof steward.requireTrust, 'function');
    assert.equal(typeof steward.trustHome, 'function');
    assert.equal(typeof steward.projectKey, 'function');
    assert.equal(typeof steward.doctor, 'function');
    assert.equal(typeof steward.report, 'function');
    assert.equal(typeof steward.pruneAudit, 'function');
    assert.equal(typeof steward.auditInstructions, 'function');

    assert.equal(typeof steward.handleHook, 'function');
    assert.equal(typeof steward.normalizeInput, 'function');
    assert.equal(typeof steward.encode, 'function');
    assert.equal(typeof steward.eventKind, 'function');
    assert.equal(typeof steward.inferAntigravityEvent, 'function');
    assert.ok(Array.isArray(steward.HOSTS));

    assert.equal(typeof steward.startMcpServer, 'function');
    assert.equal(typeof steward.handleMcpMessage, 'function');
    assert.equal(typeof steward.executeTool, 'function');
    assert.equal(typeof steward.readResource, 'function');
    assert.equal(typeof steward.formatMcpConfig, 'function');
    assert.equal(steward.STEWARD_TOOLS.length, 11);
    assert.ok(steward.STEWARD_RESOURCES.length >= 5);

    assert.equal(typeof steward.generateSigningKeyPair, 'function');
    assert.equal(typeof steward.signData, 'function');
    assert.equal(typeof steward.verifySignature, 'function');
    assert.equal(typeof steward.signBundle, 'function');
    assert.equal(typeof steward.verifyBundleSignature, 'function');
    assert.equal(typeof steward.signVerificationEvidence, 'function');
    assert.equal(typeof steward.verifyVerificationEvidence, 'function');
    assert.equal(typeof steward.saveKeypair, 'function');
    assert.equal(typeof steward.loadKeypair, 'function');
    assert.equal(typeof steward.deriveKeyId, 'function');
    assert.equal(typeof steward.resolveKeyPem, 'function');

    assert.equal(typeof steward.initProject, 'function');
    assert.equal(typeof steward.installHooks, 'function');
    assert.equal(typeof steward.StewardError, 'function');
    assert.equal(typeof steward.insist, 'function');
    assert.equal(typeof steward.publicError, 'function');
});

test('index.d.ts declares every runtime export from src/index.mjs and resolves all referenced types', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { PACKAGE } = await import('./helpers.mjs');
    const dts = fs.readFileSync(path.join(PACKAGE, 'index.d.ts'), 'utf8');

    for (const key of Object.keys(steward)) {
        const re = new RegExp(`export\\s+(?:declare\\s+)?(?:const|function|class)\\s+${key}\\b`);
        assert.match(dts, re, `Missing TypeScript declaration for exported symbol: ${key}`);
    }

    const declaredTypes = new Set([
        'Error', 'Record', 'Promise', 'Readonly', 'ReadonlyArray', 'Buffer', 'NodeJS', 'T',
        ...Array.from(dts.matchAll(/export\s+(?:interface|type|class)\s+([A-Z]\w*)/g), m => m[1])
    ]);
    for (const match of dts.matchAll(/(?::\s*|\|\s*|<\s*|extends\s+)([A-Z][A-Za-z0-9_]*)\b/g)) {
        assert.ok(declaredTypes.has(match[1]), `Undeclared type reference in index.d.ts: ${match[1]}`);
    }

    assert.match(dts, /export type RuleEvent = 'prompt' \| 'tool' \| 'session' \| 'stop';/);
    assert.match(dts, /export interface PublicErrorObject/);
    assert.match(dts, /status: 'unchecked' \| 'needs-attention';/);
    assert.match(dts, /tags\?: string\[\];/);
    assert.match(dts, /receipt: string/);
    assert.match(dts, /neverEmitted: string\[\]/);
});

test('JSON Schemas in schemas/*.json stay aligned with runtime schema validators', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { PACKAGE } = await import('./helpers.mjs');

    const journalSchema = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'schemas/journal-entry.schema.json'), 'utf8'));
    const schemaTypes = journalSchema.oneOf.map(branch => branch.properties.type.const);
    assert.deepEqual(schemaTypes, steward.RECORD_TYPES);

    for (const branch of journalSchema.oneOf) {
        const typeName = branch.properties.type.const;
        assert.ok(branch.properties.data.properties.tags, `schemas/journal-entry.schema.json missing data.properties.tags for ${typeName}`);
        assert.equal(branch.properties.data.properties.tags.maxItems, 16);
    }

    const verifySchema = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'schemas/verification.schema.json'), 'utf8'));
    assert.equal(verifySchema.properties.exclude.uniqueItems, true);
    assert.equal(verifySchema.properties.exclude.items.maxLength, 2048);
});

