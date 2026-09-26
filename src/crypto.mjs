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
    const keyId = deriveKeyId(publicKey);
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
 * Validates against null bytes, path traversal, and file size limits.
 *
 * @param {string} input - File path or PEM content.
 * @returns {string} Clean PEM string.
 */
export function resolveKeyPem(input) {
    insist(typeof input === 'string' && input.trim(), 'USAGE', 'Key input is required.');
    if (input.includes('-----BEGIN')) {
        return input.trim();
    }
    insist(!input.includes('\0'), 'BAD_PATH', 'Path contains null byte.');
    const resolved = path.resolve(input);
    insist(path.isAbsolute(resolved), 'BAD_PATH', 'Expected absolute resolved path.');
    insist(fs.existsSync(resolved), 'CRYPTO_ERROR', `Key file does not exist: ${resolved}`);
    const s = fs.lstatSync(resolved);
    insist(s.isFile() && !s.isSymbolicLink(), 'BAD_FILE', 'Expected a regular, non-symlink file.');
    insist(s.size <= 64 * 1024, 'INPUT_TOO_LARGE', 'Key file exceeds 64 KiB limit.');
    return fs.readFileSync(resolved, 'utf8').trim();
}

/**
 * Safely loads a PEM key from a file or inline string, or a keypair from a directory,
 * protecting against directory traversal and symlink manipulation.
 *
 * @param {string} input - File path, directory path, or PEM content.
 * @returns {string | { privateKeyPem: string, publicKeyPem: string, keyId: string }} Clean PEM string or keypair object.
 */
export function loadKeypair(input) {
    insist(typeof input === 'string' && input.trim(), 'USAGE', 'Key input is required.');
    if (input.includes('-----BEGIN')) {
        return input.trim();
    }
    insist(!input.includes('\0'), 'BAD_PATH', 'Path contains null byte.');
    const resolved = path.resolve(input);
    insist(path.isAbsolute(resolved), 'BAD_PATH', 'Expected absolute resolved path.');
    insist(fs.existsSync(resolved), 'CRYPTO_ERROR', `Key path does not exist: ${resolved}`);
    const s = fs.lstatSync(resolved);
    insist(!s.isSymbolicLink(), 'BAD_FILE', 'Refusing symbolic link.');

    if (s.isDirectory()) {
        const privPath = path.resolve(resolved, 'steward-ed25519.priv.pem');
        const pubPath = path.resolve(resolved, 'steward-ed25519.pub.pem');
        const relPriv = path.relative(resolved, privPath);
        const relPub = path.relative(resolved, pubPath);
        insist(!relPriv.startsWith('..') && !path.isAbsolute(relPriv), 'PATH_ESCAPE', 'Private key path escapes target directory.');
        insist(!relPub.startsWith('..') && !path.isAbsolute(relPub), 'PATH_ESCAPE', 'Public key path escapes target directory.');
        insist(fs.existsSync(privPath) && fs.existsSync(pubPath), 'CRYPTO_ERROR', 'Keypair directory missing required PEM files.');
        const privPem = resolveKeyPem(privPath);
        const pubPem = resolveKeyPem(pubPath);
        const keyId = deriveKeyId(pubPem);
        return { privateKeyPem: privPem, publicKeyPem: pubPem, keyId };
    }

    return resolveKeyPem(input);
}

/**
 * Safely saves an Ed25519 keypair to an output directory, protecting against directory traversal.
 *
 * @param {string} outDir - Output directory path.
 * @param {{ privateKeyPem: string, publicKeyPem: string, keyId?: string }} keyPair - Key pair to save.
 * @returns {{ out: string, privPath: string, pubPath: string, keyId: string }} Saved paths and key ID.
 */
export function saveKeypair(outDir, keyPair) {
    insist(typeof outDir === 'string' && outDir.trim(), 'USAGE', 'Output directory is required.');
    insist(!outDir.includes('\0'), 'BAD_PATH', 'Path contains null byte.');
    insist(keyPair && typeof keyPair === 'object', 'CRYPTO_ERROR', 'Keypair object is required.');
    insist(typeof keyPair.privateKeyPem === 'string' && typeof keyPair.publicKeyPem === 'string', 'CRYPTO_ERROR', 'Invalid keypair PEM data.');

    const resolvedDir = path.resolve(outDir);
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });

    const privPath = path.resolve(resolvedDir, 'steward-ed25519.priv.pem');
    const pubPath = path.resolve(resolvedDir, 'steward-ed25519.pub.pem');

    const relPriv = path.relative(resolvedDir, privPath);
    const relPub = path.relative(resolvedDir, pubPath);
    insist(!relPriv.startsWith('..') && !path.isAbsolute(relPriv), 'PATH_ESCAPE', 'Private key path escapes target directory.');
    insist(!relPub.startsWith('..') && !path.isAbsolute(relPub), 'PATH_ESCAPE', 'Public key path escapes target directory.');

    fs.writeFileSync(privPath, keyPair.privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, keyPair.publicKeyPem, { mode: 0o644 });

    const keyId = keyPair.keyId || deriveKeyId(keyPair.publicKeyPem);
    return { out: resolvedDir, privPath, pubPath, keyId };
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

    atomicWrite(root, '.steward/state/bundle.sig.json', JSON.stringify(record, null, 2) + '\n', { replace: true });
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
    const sigPath = safePath(root, '.steward/state/bundle.sig.json');
    insist(sigRecord || fs.existsSync(sigPath), 'NO_SIGNATURE', 'Bundle signature not found.');
    const record = sigRecord || parseJSON(readText(sigPath), 'bundle signature');

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

    atomicWrite(root, `.steward/state/checks/${row.data.runId}/evidence.sig.json`, JSON.stringify(record, null, 2) + '\n', { replace: true });
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
    const sigPath = safePath(root, `.steward/state/checks/${row.data.runId}/evidence.sig.json`);
    insist(sigRecord || fs.existsSync(sigPath), 'NO_SIGNATURE', `Evidence signature not found for run ${row.data.runId}.`);
    const record = sigRecord || parseJSON(readText(sigPath), 'evidence signature');

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
