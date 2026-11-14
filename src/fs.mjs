import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { insist, StewardError } from './errors.mjs';
import { compareAscii, trimTrailingSlashes, SHA256_HEX_RE, isSha256Hex } from './matcher.mjs';

export { compareAscii, trimTrailingSlashes, SHA256_HEX_RE, isSha256Hex };

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function toSessionHash(sessionId) {
    if (sessionId == null) return null;
    return isSha256Hex(sessionId) ? sessionId : sha256(sessionId);
}

export function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort(compareAscii);
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
}
export function rootOf(project) {
    let root, stat;
    try {
        root = fs.realpathSync(path.resolve(project)); //NOSONAR
        stat = fs.statSync(root); //NOSONAR
    }
    catch (e) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR')
            throw new StewardError('BAD_PROJECT', 'Project must be an existing directory.');
        throw e;
    }
    insist(stat.isDirectory(), 'BAD_PROJECT', 'Project must be an existing directory.');
    return root;
}
// Never follow a symlink below the selected root for control-plane reads or writes.
// This is a cooperative local-file boundary, not protection against hostile TOCTOU races.
export function safePath(root, relative) {
    insist(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'BAD_PATH', 'Expected a relative control path.');
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    insist(rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'PATH_ESCAPE', 'Path leaves the selected root.');
    let cursor = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try {
            insist(!fs.lstatSync(cursor).isSymbolicLink(), 'SYMLINK', `Refusing symbolic link: ${path.relative(root, cursor)}`); //NOSONAR
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    return target;
}
export function readText(file, maxBytes = 1024 * 1024) {
    let s;
    try {
        s = fs.lstatSync(file); //NOSONAR
    }
    catch (e) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR')
            throw new StewardError('MISSING_FILE', `File does not exist: ${path.basename(file)}`);
        throw e;
    }
    insist(s.isFile() && !s.isSymbolicLink(), 'BAD_FILE', 'Expected a regular, non-symlink file.');
    insist(s.size <= maxBytes, 'INPUT_TOO_LARGE', `File exceeds ${maxBytes} bytes.`);
    const bytes = fs.readFileSync(file); //NOSONAR
    insist(bytes.length <= maxBytes, 'INPUT_TOO_LARGE', 'File grew past its size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function parseJSON(text, label = 'input') {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new StewardError('INVALID_JSON', `Invalid JSON in ${label}.`);
    }
}
export function readJSON(file, maxBytes) {
    return parseJSON(readText(file, maxBytes), path.basename(file));
}
export function mkdir(root, relative) {
    const target = safePath(root, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 }); //NOSONAR
    return target;
}
export function atomicWrite(root, relative, text, { replace = false } = {}) {
    const target = safePath(root, relative);
    mkdir(root, path.relative(root, path.dirname(target)) || '.');
    const temp = path.join(path.dirname(target), '.tmp-' + randomUUID());
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600); //NOSONAR
        fs.writeFileSync(fd, text); //NOSONAR
        fs.fsyncSync(fd); //NOSONAR
        fs.closeSync(fd); //NOSONAR
        fd = undefined;
        safePath(root, relative);
        if (replace)
            fs.renameSync(temp, target); //NOSONAR
        else {
            fs.linkSync(temp, target); //NOSONAR
            fs.unlinkSync(temp); //NOSONAR
        }
    }
    catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {} //NOSONAR
        }
        try { fs.unlinkSync(temp); } catch {} //NOSONAR
        throw error;
    }
}
async function removeLockDir(lock, retry = 0) {
    const maxRetries = process.platform === 'win32' ? 5 : 1;
    try {
        fs.rmdirSync(lock); //NOSONAR
    }
    catch (e) {
        if (e.code === 'ENOENT' || retry + 1 >= maxRetries)
            return;
        await new Promise(r => setTimeout(r, 10 * (retry + 1)));
        await removeLockDir(lock, retry + 1);
    }
}
async function acquireLockDir(lock, end) {
    try {
        fs.mkdirSync(lock, { mode: 0o700 }); //NOSONAR
    }
    catch (e) {
        const isLockContention = e.code === 'EEXIST' || (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES'));
        if (!isLockContention)
            throw e;
        insist(Date.now() < end, 'LOCKED', 'Another writer holds the lock. A crashed-writer lock requires explicit operator recovery.');
        await new Promise(r => setTimeout(r, 15));
        await acquireLockDir(lock, end);
    }
}
export async function withLock(root, relative, fn, timeoutMs = 5000) {
    const lock = safePath(root, relative);
    mkdir(root, path.relative(root, path.dirname(lock)) || '.');
    const end = Date.now() + timeoutMs;
    await acquireLockDir(lock, end);
    try {
        return await fn();
    }
    finally {
        await removeLockDir(lock);
    }
}
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_DIRS = 10000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const OPEN_READ_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

export function deepFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Object.isFrozen(value)) return value;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            deepFreeze(value[i]);
        }
    } else {
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            deepFreeze(value[keys[i]]);
        }
    }
    return Object.freeze(value);
}

export function walk(root, { exclude = () => false, maxFiles = 20000, maxDepth = MAX_SNAPSHOT_DEPTH, maxDirs = MAX_SNAPSHOT_DIRS } = {}) {
    const result = [];
    let total = 0;
    let dirsVisited = 0;
    function readTextOrBytes(file) {
        let fd;
        try {
            fd = fs.openSync(file, OPEN_READ_NOFOLLOW); //NOSONAR
        } catch (err) {
            if (err?.code === 'ELOOP') {
                throw new StewardError('SPECIAL_FILE', 'Refusing symbolic link swap during snapshot.');
            }
            throw err;
        }
        try {
            const stat = fs.fstatSync(fd); //NOSONAR
            if (!stat.isFile()) {
                throw new StewardError('SPECIAL_FILE', 'Workspace contains a non-regular file.');
            }
            insist(total + stat.size <= MAX_SNAPSHOT_BYTES, 'WORKSPACE_TOO_LARGE', 'Snapshot exceeds 128 MiB.');
            const bytes = fs.readFileSync(fd); //NOSONAR
            total += bytes.length;
            insist(total <= MAX_SNAPSHOT_BYTES, 'WORKSPACE_TOO_LARGE', 'Snapshot exceeds 128 MiB.');
            return {
                executable: (stat.mode & 0o111) !== 0 ? 1 : 0,
                bytes
            };
        } finally {
            fs.closeSync(fd);
        }
    }
    function visit(dir, depth) {
        insist(depth <= maxDepth, 'TOO_DEEP', `Workspace snapshot exceeded depth limit (${maxDepth}).`);
        insist(++dirsVisited <= maxDirs, 'TOO_MANY_FILES', `Workspace directory limit exceeded (${maxDirs}).`);
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name)); //NOSONAR
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            const rel = path.relative(root, file).split(path.sep).join('/');
            if (exclude(rel, entry))
                continue;
            insist(result.length < maxFiles, 'TOO_MANY_FILES', 'Workspace file limit exceeded.');
            if (entry.isDirectory()) {
                visit(file, depth + 1);
            }
            else if (entry.isSymbolicLink()) {
                result.push({ path: rel, kind: 'link', hash: sha256(fs.readlinkSync(file)) }); //NOSONAR
            }
            else if (entry.isFile()) {
                const { executable, bytes } = readTextOrBytes(file);
                result.push({ path: rel, kind: 'file', executable, hash: sha256(bytes) });
            }
            else {
                throw new StewardError('SPECIAL_FILE', 'Workspace contains a non-regular file.');
            }
        }
    }
    visit(root, 0);
    return result;
}
export function snapshot(root, extraExcludes = []) {
    const normalizedExcludes = extraExcludes.map(x => trimTrailingSlashes(String(x))).filter(Boolean);
    const files = walk(root, {
        exclude: (p, entry) =>
            entry.name === '.git' ||
            entry.name === 'node_modules' ||
            entry.name === '.worktrees' ||
            entry.name === '.DS_Store' ||
            entry.name === 'Thumbs.db' ||
            entry.name === 'desktop.ini' ||
            p === '.steward/state' ||
            p === '.steward/USAGE.md' ||
            p === '.steward/install.lock' ||
            p.startsWith('.steward/install-') ||
            normalizedExcludes.some(x => p === x || p.startsWith(x + '/'))
    });
    return {
        hash: sha256(canonical(files)),
        files: files.length,
        excluded: ['.git/', 'node_modules/', '.worktrees/', '.steward/state/', '.steward/USAGE.md', '.steward/install-*', ...extraExcludes]
    };
}
