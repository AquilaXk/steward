import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { insist, StewardError } from './errors.mjs';
import { canonical, sha256, safePath, readText, parseJSON, atomicWrite } from './fs.mjs';
import { isObject } from './schema.mjs';
import { loadBundle } from './trust.mjs';
import { readJournal } from './journal.mjs';

const HEX_128_RE = /^[0-9a-fA-F]{128}$/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d\d-\d\dT/;

function isIsoTimestamp(value) {
    return typeof value === 'string' && value.length <= 80 && ISO_DATE_PREFIX_RE.test(value) && Number.isFinite(Date.parse(value));
}

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
    if (typeof signatureHex !== 'string' || signatureHex.length !== 128 || !HEX_128_RE.test(signatureHex) || typeof publicKeyPem !== 'string') {
        return false;
    }
    try {
        const buffer = toSignableBuffer(data);
        const sigBuffer = Buffer.from(signatureHex, 'hex');
        if (sigBuffer.length !== 64) return false;
        return crypto.verify(null, buffer, publicKeyPem, sigBuffer);
    } catch {
        return false;
    }
}

function validateSafeKeyInput(input, label = 'Key') {
    if (typeof input !== 'string' || !input.trim()) {
        throw new StewardError('USAGE', 'Key input is required.');
    }
    if (input.includes('-----BEGIN')) {
        return { isInline: true, pem: input.trim() };
    }
    if (input.includes('\0')) {
        throw new StewardError('BAD_PATH', 'Path contains null byte.');
    }
    const resolved = path.resolve(input);
    if (!path.isAbsolute(resolved)) {
        throw new StewardError('BAD_PATH', 'Expected absolute resolved path.');
    }
    let stat;
    try {
        stat = fs.lstatSync(resolved); //NOSONAR
    } catch (err) {
        if (err?.code === 'ENOENT') {
            throw new StewardError('CRYPTO_ERROR', `${label} does not exist: ${resolved}`);
        }
        throw err;
    }
    if (stat.isSymbolicLink()) {
        throw new StewardError('BAD_FILE', 'Refusing symbolic link.');
    }
    return { isInline: false, resolved, stat };
}

function resolveKeypairPaths(dir) {
    const privFile = path.basename('steward-ed25519.priv.pem');
    const pubFile = path.basename('steward-ed25519.pub.pem');
    const privPath = path.resolve(dir, privFile);
    const pubPath = path.resolve(dir, pubFile);
    if (!privPath.startsWith(dir + path.sep) || !pubPath.startsWith(dir + path.sep)) {
        throw new StewardError('PATH_ESCAPE', 'Key path escapes target directory.');
    }
    const relPriv = path.relative(dir, privPath);
    const relPub = path.relative(dir, pubPath);
    if (relPriv.startsWith('..') || path.isAbsolute(relPriv) || relPub.startsWith('..') || path.isAbsolute(relPub)) {
        throw new StewardError('PATH_ESCAPE', 'Key path escapes target directory.');
    }
    return { privPath, pubPath };
}

/**
 * Loads a public or private key from a file path, keypair directory, or direct PEM string.
 * Validates against null bytes, symlinks, and file size limits.
 *
 * @param {string} input - File path, directory path, or PEM content.
 * @param {'any'|'private'|'public'|'file'} [role='any'] - Expected key role when input is a directory.
 * @returns {string} Clean PEM string.
 */
export function resolveKeyPem(input, role = 'any') {
    const checked = validateSafeKeyInput(input, 'Key file');
    if (checked.isInline) {
        return checked.pem;
    }
    const { resolved, stat } = checked;
    if (stat.isDirectory() && role !== 'file') {
        const { privPath, pubPath } = resolveKeypairPaths(resolved);
        if (role === 'private') return resolveKeyPem(privPath, 'file');
        if (role === 'public') return resolveKeyPem(pubPath, 'file');
        if (fs.existsSync(privPath)) return resolveKeyPem(privPath, 'file');
        if (fs.existsSync(pubPath)) return resolveKeyPem(pubPath, 'file');
        throw new StewardError('CRYPTO_ERROR', 'Keypair directory missing required PEM files.');
    }
    if (!stat.isFile()) {
        throw new StewardError('BAD_FILE', 'Expected a regular, non-symlink file.');
    }
    if (stat.size > 64 * 1024) {
        throw new StewardError('INPUT_TOO_LARGE', 'Key file exceeds 64 KiB limit.');
    }
    return fs.readFileSync(resolved, 'utf8').trim(); //NOSONAR
}

/**
 * Safely loads a PEM key from a file or inline string, or a keypair from a directory,
 * protecting against directory traversal and symlink manipulation.
 *
 * @param {string} input - File path, directory path, or PEM content.
 * @returns {string | { privateKeyPem: string, publicKeyPem: string, keyId: string }} Clean PEM string or keypair object.
 */
export function loadKeypair(input) {
    const checked = validateSafeKeyInput(input, 'Key path');
    if (checked.isInline) {
        return checked.pem;
    }
    const { resolved, stat } = checked;
    if (stat.isDirectory()) {
        const { privPath, pubPath } = resolveKeypairPaths(resolved);
        if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
            throw new StewardError('CRYPTO_ERROR', 'Keypair directory missing required PEM files.');
        }
        const privPem = resolveKeyPem(privPath, 'file');
        const pubPem = resolveKeyPem(pubPath, 'file');
        const keyId = deriveKeyId(pubPem);
        return { privateKeyPem: privPem, publicKeyPem: pubPem, keyId };
    }

    return resolveKeyPem(resolved, 'file');
}

function validateSaveKeypairInputs(outDir, keyPair) {
    if (typeof outDir !== 'string' || !outDir.trim()) {
        throw new StewardError('USAGE', 'Output directory is required.');
    }
    if (outDir.includes('\0')) {
        throw new StewardError('BAD_PATH', 'Path contains null byte.');
    }
    if (!keyPair || typeof keyPair !== 'object') {
        throw new StewardError('CRYPTO_ERROR', 'Keypair object is required.');
    }
    if (typeof keyPair.privateKeyPem !== 'string' || typeof keyPair.publicKeyPem !== 'string') {
        throw new StewardError('CRYPTO_ERROR', 'Invalid keypair PEM data.');
    }
}

function assertExistingTargetIsSafe(targetPath, expectDirectory) {
    try {
        const st = fs.lstatSync(targetPath); //NOSONAR
        const validKind = expectDirectory ? st.isDirectory() : st.isFile();
        if (st.isSymbolicLink() || !validKind) {
            const msg = expectDirectory
                ? 'Output directory must be a regular directory, not a symbolic link.'
                : 'Refusing to overwrite symbolic link or non-regular file.';
            throw new StewardError('BAD_FILE', msg);
        }
    } catch (err) {
        if (err instanceof StewardError || err?.code !== 'ENOENT') throw err;
    }
}

/**
 * Safely saves an Ed25519 keypair to an output directory, protecting against symlink overwrites
 * and enforcing strict 0600 permissions on the private key.
 *
 * @param {string} outDir - Output directory path.
 * @param {{ privateKeyPem: string, publicKeyPem: string, keyId?: string }} keyPair - Key pair to save.
 * @returns {{ out: string, privPath: string, pubPath: string, keyId: string }} Saved paths and key ID.
 */
export function saveKeypair(outDir, keyPair) {
    validateSaveKeypairInputs(outDir, keyPair);
    const baseDir = path.resolve(outDir);
    assertExistingTargetIsSafe(baseDir, true);

    const { privPath, pubPath } = resolveKeypairPaths(baseDir);
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 }); //NOSONAR
    assertExistingTargetIsSafe(privPath, false);
    assertExistingTargetIsSafe(pubPath, false);

    fs.writeFileSync(privPath, keyPair.privateKeyPem, { mode: 0o600 }); //NOSONAR
    fs.chmodSync(privPath, 0o600); //NOSONAR
    fs.writeFileSync(pubPath, keyPair.publicKeyPem, { mode: 0o644 }); //NOSONAR
    fs.chmodSync(pubPath, 0o644); //NOSONAR

    const keyId = keyPair.keyId || deriveKeyId(keyPair.publicKeyPem);
    return { out: baseDir, privPath, pubPath, keyId };
}

/**
 * Signs the project's trust bundle (policy and verification plan) using an Ed25519 private key.
 *
 * @param {string} root - Project root.
 * @param {string} privateKeyPem - Private key PEM, file path, or keypair directory.
 * @returns {object} Signature metadata record.
 */
export function signBundle(root, privateKeyPem) {
    const bundle = loadBundle(root);
    const privPem = resolveKeyPem(privateKeyPem, 'private');
    const { signature } = signData(bundle.hash, privPem);

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
 * @param {string} publicKeyInput - Public key path, directory, or PEM.
 * @param {object} [sigRecord] - Optional explicit signature record.
 * @returns {{ valid: boolean, bundleHash: string, signedAt: string, keyId: string }}
 */
export function verifyBundleSignature(root, publicKeyInput, sigRecord = null) {
    const bundle = loadBundle(root);
    const pubPem = resolveKeyPem(publicKeyInput, 'public');
    const sigPath = safePath(root, '.steward/state/bundle.sig.json');
    insist(sigRecord !== null || fs.existsSync(sigPath), 'NO_SIGNATURE', 'Bundle signature not found.');
    const record = sigRecord !== null ? sigRecord : parseJSON(readText(sigPath), 'bundle signature');

    insist(
        isObject(record) && record.version === 1 && record.target === 'bundle' && record.alg === 'ed25519' && isIsoTimestamp(record.signedAt),
        'CRYPTO_ERROR',
        'Invalid signature envelope.'
    );
    insist(record.bundleHash === bundle.hash, 'APPROVAL_MISMATCH', 'Signed bundle hash differs from current bundle.');

    const valid = verifySignature(bundle.hash, record.signature, pubPem);
    insist(valid, 'SIGNATURE_INVALID', 'Ed25519 signature verification failed for policy bundle.');
    insist(record.keyId === deriveKeyId(pubPem), 'APPROVAL_MISMATCH', 'Signature record key ID does not match verifier public key.');

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
 * @param {string} privateKeyInput - Private key path, directory, or PEM.
 * @returns {object} Signed evidence record.
 */
export function signVerificationEvidence(root, evidenceHash, privateKeyInput) {
    const rows = readJournal(root, { fresh: true });
    const row = rows.find(r => r.hash === evidenceHash && r.type === 'verification');
    insist(row, 'NO_EVIDENCE', `Verification evidence not found: ${evidenceHash}`);

    const privPem = resolveKeyPem(privateKeyInput, 'private');
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
 * @param {string} publicKeyInput - Public key path, directory, or PEM.
 * @param {object} [sigRecord] - Optional explicit signature record.
 * @returns {{ valid: boolean, evidenceHash: string, keyId: string, signedAt: string }}
 */
export function verifyVerificationEvidence(root, evidenceHash, publicKeyInput, sigRecord = null) {
    const rows = readJournal(root, { fresh: true });
    const row = rows.find(r => r.hash === evidenceHash && r.type === 'verification');
    insist(row, 'NO_EVIDENCE', `Verification evidence not found: ${evidenceHash}`);

    const pubPem = resolveKeyPem(publicKeyInput, 'public');
    const sigPath = safePath(root, `.steward/state/checks/${row.data.runId}/evidence.sig.json`);
    insist(sigRecord !== null || fs.existsSync(sigPath), 'NO_SIGNATURE', `Evidence signature not found for run ${row.data.runId}.`);
    const record = sigRecord !== null ? sigRecord : parseJSON(readText(sigPath), 'evidence signature');

    insist(
        isObject(record) && record.version === 1 && record.target === 'evidence' && record.alg === 'ed25519' && isIsoTimestamp(record.signedAt),
        'CRYPTO_ERROR',
        'Invalid evidence signature record.'
    );
    insist(record.evidenceHash === evidenceHash, 'APPROVAL_MISMATCH', 'Signature record evidence hash mismatch.');
    insist(record.runId === row.data.runId, 'APPROVAL_MISMATCH', 'Signature record run ID mismatch.');
    insist(record.workspaceHash === row.data.workspace.hash, 'APPROVAL_MISMATCH', 'Signature record workspace hash mismatch.');

    const payload = `${evidenceHash}:${row.data.runId}:${row.data.workspace.hash}`;
    const valid = verifySignature(payload, record.signature, pubPem);
    insist(valid, 'SIGNATURE_INVALID', 'Ed25519 signature verification failed for verification evidence.');
    insist(record.keyId === deriveKeyId(pubPem), 'APPROVAL_MISMATCH', 'Signature record key ID does not match verifier public key.');

    return {
        valid: true,
        evidenceHash,
        keyId: record.keyId,
        signedAt: record.signedAt
    };
}

