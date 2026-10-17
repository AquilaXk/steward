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
    verifyVerificationEvidence,
    saveKeypair,
    loadKeypair,
    resolveKeyPem
} from '../src/crypto.mjs';
import { runVerification } from '../src/verify.mjs';
import path from 'node:path';
import fs from 'node:fs';

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

    // Non-hex trailing characters and non-128-char hex strings rejected strictly
    assert.equal(verifySignature(data, signature + 'zzzz', keyPair.publicKeyPem), false);
    assert.equal(verifySignature(data, 'zz' + signature.slice(2), keyPair.publicKeyPem), false);
    assert.equal(verifySignature(data, signature.slice(0, 126), keyPair.publicKeyPem), false);
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

    // Unrelated key rejects (keyId mismatch caught before or during verification)
    const anotherKeyPair = generateSigningKeyPair();
    assert.throws(() => verifyBundleSignature(root, anotherKeyPair.publicKeyPem), (err) => {
        return err.code === 'APPROVAL_MISMATCH' || err.code === 'SIGNATURE_INVALID';
    });

    // Tampered keyId or signedAt or non-object sigRecord rejected
    assert.throws(
        () => verifyBundleSignature(root, keyPair.publicKeyPem, { ...sigRecord, keyId: '0'.repeat(32) }),
        { code: 'APPROVAL_MISMATCH' }
    );
    assert.throws(
        () => verifyBundleSignature(root, keyPair.publicKeyPem, { ...sigRecord, signedAt: 'not-a-date' }),
        { code: 'CRYPTO_ERROR' }
    );
    assert.throws(
        () => verifyBundleSignature(root, keyPair.publicKeyPem, 'not-an-object'),
        { code: 'CRYPTO_ERROR' }
    );
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

    // Tampered workspaceHash, keyId, or signedAt in evidence signature record rejected
    assert.throws(
        () => verifyVerificationEvidence(root, report.evidence, keyPair.publicKeyPem, { ...sig, workspaceHash: 'f'.repeat(64) }),
        { code: 'APPROVAL_MISMATCH' }
    );
    assert.throws(
        () => verifyVerificationEvidence(root, report.evidence, keyPair.publicKeyPem, { ...sig, keyId: '0'.repeat(32) }),
        { code: 'APPROVAL_MISMATCH' }
    );
    assert.throws(
        () => verifyVerificationEvidence(root, report.evidence, keyPair.publicKeyPem, { ...sig, signedAt: 'invalid-date' }),
        { code: 'CRYPTO_ERROR' }
    );
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

test('saveKeypair and loadKeypair safely store and retrieve keys with path validation, chmod 0600, and directory resolveKeyPem', (t) => {
    const { root } = sandbox(t);
    const keyPair = generateSigningKeyPair();
    const outDir = path.join(root, 'keys');

    const saved = saveKeypair(outDir, keyPair);
    assert.equal(saved.out, path.resolve(outDir));
    assert(fs.existsSync(saved.privPath));
    assert(fs.existsSync(saved.pubPath));

    if (process.platform !== 'win32') {
        // Widen permissions on privPath and verify saveKeypair restores 0o600
        fs.chmodSync(saved.privPath, 0o644);
        saveKeypair(outDir, keyPair);
        const mode = fs.statSync(saved.privPath).mode & 0o777;
        assert.equal(mode, 0o600);
    }

    // resolveKeyPem and signBundle/verifyBundleSignature accept a keypair directory directly
    assert.equal(resolveKeyPem(outDir, 'private'), keyPair.privateKeyPem.trim());
    assert.equal(resolveKeyPem(outDir, 'public'), keyPair.publicKeyPem.trim());
    const bundleSig = signBundle(root, outDir);
    assert.equal(bundleSig.keyId, keyPair.keyId);
    const bundleVer = verifyBundleSignature(root, outDir);
    assert.equal(bundleVer.valid, true);

    // Symlinked target file in saveKeypair is refused
    const symDir = path.join(root, 'sym-keys');
    fs.mkdirSync(symDir, { recursive: true });
    const victimFile = path.join(root, 'victim.txt');
    fs.writeFileSync(victimFile, 'keep-me');
    fs.symlinkSync(victimFile, path.join(symDir, 'steward-ed25519.priv.pem'));
    assert.throws(() => saveKeypair(symDir, keyPair), { code: 'BAD_FILE' });
    assert.equal(fs.readFileSync(victimFile, 'utf8'), 'keep-me');

    const loadedPriv = loadKeypair(saved.privPath);
    const loadedPub = loadKeypair(saved.pubPath);
    assert.equal(loadedPriv, keyPair.privateKeyPem.trim());
    assert.equal(loadedPub, keyPair.publicKeyPem.trim());

    // Directory-based keypair loading
    const loadedPair = loadKeypair(outDir);
    assert.equal(typeof loadedPair, 'object');
    assert.equal(loadedPair.privateKeyPem, keyPair.privateKeyPem.trim());
    assert.equal(loadedPair.publicKeyPem, keyPair.publicKeyPem.trim());
    assert.equal(loadedPair.keyId, keyPair.keyId);

    // Path with null byte rejected
    assert.throws(() => saveKeypair(outDir + '\0bad', keyPair), { code: 'BAD_PATH' });
    assert.throws(() => loadKeypair(saved.privPath + '\0bad'), { code: 'BAD_PATH' });

    // Empty directory missing PEM files rejected
    const emptyDir = path.join(root, 'empty-keys');
    fs.mkdirSync(emptyDir);
    assert.throws(() => loadKeypair(emptyDir), { code: 'CRYPTO_ERROR' });
});

