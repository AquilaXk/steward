import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, plan } from './helpers.mjs';
import {
    generateSigningKeyPair,
    signData,
    verifySignature,
    signBundle,
    verifyBundleSignature,
    signVerificationEvidence,
    verifyVerificationEvidence
} from '../src/crypto.mjs';
import { runVerification } from '../src/verify.mjs';

test('Ed25519 key generation, signing, and verification', () => {
    const keyPair = generateSigningKeyPair();
    assert(keyPair.privateKeyPem.includes('BEGIN PRIVATE KEY'));
    assert(keyPair.publicKeyPem.includes('BEGIN PUBLIC KEY'));
    assert.equal(keyPair.keyId.length, 32);

    const data = { action: 'deploy', commit: 'abcdef1234567890' };
    const { signature, alg } = signData(data, keyPair.privateKeyPem);
    assert.equal(alg, 'ed25519');
    assert(signature.length > 0);

    // Verify valid signature
    const valid = verifySignature(data, signature, keyPair.publicKeyPem);
    assert.equal(valid, true);

    // Tampered data rejected
    const invalidData = verifySignature({ ...data, commit: 'corrupted' }, signature, keyPair.publicKeyPem);
    assert.equal(invalidData, false);

    // Tampered signature rejected
    const tamperedSig = signature.slice(0, -2) + (signature.endsWith('0') ? '1' : '0');
    const invalidSig = verifySignature(data, tamperedSig, keyPair.publicKeyPem);
    assert.equal(invalidSig, false);
});

test('Ed25519 bundle signing and verification', (t) => {
    const { root } = sandbox(t);
    const keyPair = generateSigningKeyPair();

    const sigRecord = signBundle(root, keyPair.privateKeyPem);
    assert.equal(sigRecord.alg, 'ed25519');
    assert.equal(sigRecord.target, 'bundle');

    const result = verifyBundleSignature(root, keyPair.publicKeyPem);
    assert.equal(result.valid, true);
    assert.equal(result.bundleHash, sigRecord.bundleHash);

    // Unrelated key rejects
    const anotherKeyPair = generateSigningKeyPair();
    assert.throws(() => verifyBundleSignature(root, anotherKeyPair.publicKeyPem), { code: 'SIGNATURE_INVALID' });
});

test('Ed25519 verification evidence signing and verifier gate', async (t) => {
    const { root } = sandbox(t, { plan: plan() });
    const keyPair = generateSigningKeyPair();

    const report = await runVerification(root);
    assert.equal(report.allPassed, true);

    const sig = signVerificationEvidence(root, report.evidence, keyPair.privateKeyPem);
    assert.equal(sig.evidenceHash, report.evidence);

    const verified = verifyVerificationEvidence(root, report.evidence, keyPair.publicKeyPem);
    assert.equal(verified.valid, true);
    assert.equal(verified.evidenceHash, report.evidence);
});

test('Ed25519 verification throws NO_SIGNATURE when signature file is missing', async (t) => {
    const { root } = sandbox(t, { plan: plan() });
    const keyPair = generateSigningKeyPair();

    // Bundle not signed yet
    assert.throws(() => verifyBundleSignature(root, keyPair.publicKeyPem), { code: 'NO_SIGNATURE' });

    // Run verification without signing evidence
    const report = await runVerification(root);
    assert.throws(() => verifyVerificationEvidence(root, report.evidence, keyPair.publicKeyPem), { code: 'NO_SIGNATURE' });
});
