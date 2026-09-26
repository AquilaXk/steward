import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { insist } from './errors.mjs';
import { canonical, sha256, safePath, readText, parseJSON, atomicWrite } from './fs.mjs';
import { loadBundle } from './trust.mjs';
import { readJournal } from './journal.mjs';

/**
 * Generates an Ed25519 asymmetric key pair.
 * Returns PEM-encoded keys and a deterministic key ID.
 *
 * @returns {{ privateKeyPem: string, publicKeyPem: string, keyId: string }}
 */
export function generateSigningKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const keyId = sha256(publicKey).slice(0, 32);
    return { privateKeyPem: privateKey, publicKeyPem: publicKey, keyId };
}

/**
 * Resolves raw input data into a consistent Buffer for digital signing.
 * @param {string|Buffer|object} data
 * @returns {Buffer}
 */
function toSignableBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (data && typeof data === 'object') return Buffer.from(canonical(data), 'utf8');
    throw new TypeError('Invalid signable data type');
}

/**
 * Derives a key ID from a public key PEM string.
 * @param {string} publicKeyPem
 * @returns {string} 32-character hex ID.
 */
export function deriveKeyId(publicKeyPem) {
    return sha256(publicKeyPem.trim()).slice(0, 32);
}

/**
 * Signs payload data using an Ed25519 private key.
 *
 * @param {string|Buffer|object} data - Payload to sign.
 * @param {string} privateKeyPem - PKCS8 PEM private key.
 * @returns {{ alg: string, signature: string }}
 */
export function signData(data, privateKeyPem) {
    insist(typeof privateKeyPem === 'string' && privateKeyPem.includes('PRIVATE KEY'), 'CRYPTO_ERROR', 'Invalid private key PEM.');
    const buffer = toSignableBuffer(data);
    const signature = crypto.sign(null, buffer, privateKeyPem);
    return {
        alg: 'ed25519',
        signature: signature.toString('hex')
    };
}

/**
 * Verifies payload data against an Ed25519 signature and public key.
 *
 * @param {string|Buffer|object} data - Payload that was signed.
 * @param {string} signatureHex - Hex signature string.
 * @param {string} publicKeyPem - SPKI PEM public key.
 * @returns {boolean} True if signature is cryptographically valid.
 */
export function verifySignature(data, signatureHex, publicKeyPem) {
    if (!signatureHex || typeof signatureHex !== 'string' || typeof publicKeyPem !== 'string') return false;
    try {
        const buffer = toSignableBuffer(data);
        const sigBuffer = Buffer.from(signatureHex, 'hex');
        return crypto.verify(null, buffer, publicKeyPem, sigBuffer);
    } catch {
        return false;
    }
}

/**
 * Loads a public or private key from a file path or direct PEM string.
 *
 * @param {string} input - File path or PEM content.
 * @returns {string} Clean PEM string.
 */
export function resolveKeyPem(input) {
    insist(typeof input === 'string' && input.trim(), 'USAGE', 'Key input is required.');
    if (input.includes('-----BEGIN')) {
        return input.trim();
    }
    const resolved = path.resolve(input);
    insist(fs.existsSync(resolved), 'CRYPTO_ERROR', `Key file does not exist: ${resolved}`);
    return fs.readFileSync(resolved, 'utf8').trim();
}

/**
 * Signs the project's trust bundle (policy and verification plan) using an Ed25519 private key.
 *
 * @param {string} root - Project root.
 * @param {string} privateKeyPem - Private key PEM.
 * @returns {object} Signature metadata record.
 */
export function signBundle(root, privateKeyPem) {
    const bundle = loadBundle(root);
    const privPem = resolveKeyPem(privateKeyPem);
    const { signature } = signData(bundle.hash, privPem);

    // Compute corresponding public key if possible, or derive key ID
    let keyId = 'unknown';
    try {
        const keyObj = crypto.createPrivateKey(privPem);
        const pubPem = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
        keyId = deriveKeyId(pubPem);
    } catch {}

    const record = {
        version: 1,
        alg: 'ed25519',
        target: 'bundle',
        bundleHash: bundle.hash,
        keyId,
        signedAt: new Date().toISOString(),
        signature
    };

    atomicWrite(root, '.steward/state/bundle.sig.json', JSON.stringify(record, null, 2) + '\n');
    return record;
}

/**
 * Verifies the signature of the project's trust bundle against an authorized public key.
 *
 * @param {string} root - Project root.
 * @param {string} publicKeyInput - Public key path or PEM.
 * @param {object} [sigRecord] - Optional explicit signature record.
 * @returns {{ valid: boolean, bundleHash: string, signedAt: string, keyId: string }}
 */
export function verifyBundleSignature(root, publicKeyInput, sigRecord = null) {
    const bundle = loadBundle(root);
    const pubPem = resolveKeyPem(publicKeyInput);
    const record = sigRecord || parseJSON(readText(safePath(root, '.steward/state/bundle.sig.json')), 'bundle signature');

    insist(record.version === 1 && record.target === 'bundle' && record.alg === 'ed25519', 'CRYPTO_ERROR', 'Invalid signature envelope.');
    insist(record.bundleHash === bundle.hash, 'APPROVAL_MISMATCH', 'Signed bundle hash differs from current bundle.');

    const valid = verifySignature(bundle.hash, record.signature, pubPem);
    insist(valid, 'SIGNATURE_INVALID', 'Ed25519 signature verification failed for policy bundle.');

    return {
        valid: true,
        bundleHash: bundle.hash,
        signedAt: record.signedAt,
        keyId: record.keyId
    };
}

/**
 * Signs a verification run evidence record with an Ed25519 private key.
 *
 * @param {string} root - Project root.
 * @param {string} evidenceHash - SHA-256 hash of the verification journal row.
 * @param {string} privateKeyInput - Private key path or PEM.
 * @returns {object} Signed evidence record.
 */
export function signVerificationEvidence(root, evidenceHash, privateKeyInput) {
    const rows = readJournal(root);
    const row = rows.find(r => r.hash === evidenceHash && r.type === 'verification');
    insist(row, 'NO_EVIDENCE', `Verification evidence not found: ${evidenceHash}`);

    const privPem = resolveKeyPem(privateKeyInput);
    const payload = `${evidenceHash}:${row.data.runId}:${row.data.workspace.hash}`;
    const { signature } = signData(payload, privPem);

    let keyId = 'unknown';
    try {
        const keyObj = crypto.createPrivateKey(privPem);
        const pubPem = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
        keyId = deriveKeyId(pubPem);
    } catch {}

    const record = {
        version: 1,
        alg: 'ed25519',
        target: 'evidence',
        evidenceHash,
        runId: row.data.runId,
        workspaceHash: row.data.workspace.hash,
        keyId,
        signedAt: new Date().toISOString(),
        signature
    };

    atomicWrite(root, `.steward/state/checks/${row.data.runId}/evidence.sig.json`, JSON.stringify(record, null, 2) + '\n');
    return record;
}

/**
 * Verifies a verification run evidence signature using an external verifier's public key.
 *
 * @param {string} root - Project root.
 * @param {string} evidenceHash - SHA-256 hash of verification journal row.
 * @param {string} publicKeyInput - Public key path or PEM.
 * @param {object} [sigRecord] - Optional explicit signature record.
 * @returns {{ valid: boolean, evidenceHash: string, keyId: string, signedAt: string }}
 */
export function verifyVerificationEvidence(root, evidenceHash, publicKeyInput, sigRecord = null) {
    const rows = readJournal(root);
    const row = rows.find(r => r.hash === evidenceHash && r.type === 'verification');
    insist(row, 'NO_EVIDENCE', `Verification evidence not found: ${evidenceHash}`);

    const pubPem = resolveKeyPem(publicKeyInput);
    const record = sigRecord || parseJSON(readText(safePath(root, `.steward/state/checks/${row.data.runId}/evidence.sig.json`)), 'evidence signature');

    insist(record.version === 1 && record.target === 'evidence' && record.alg === 'ed25519', 'CRYPTO_ERROR', 'Invalid evidence signature record.');
    insist(record.evidenceHash === evidenceHash, 'APPROVAL_MISMATCH', 'Signature record evidence hash mismatch.');
    insist(record.runId === row.data.runId, 'APPROVAL_MISMATCH', 'Signature record run ID mismatch.');

    const payload = `${evidenceHash}:${row.data.runId}:${row.data.workspace.hash}`;
    const valid = verifySignature(payload, record.signature, pubPem);
    insist(valid, 'SIGNATURE_INVALID', 'Ed25519 signature verification failed for verification evidence.');

    return {
        valid: true,
        evidenceHash,
        keyId: record.keyId,
        signedAt: record.signedAt
    };
}
