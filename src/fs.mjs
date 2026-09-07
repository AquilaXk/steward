import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { insist, StewardError } from './errors.mjs';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
}
export function rootOf(project) {
    const root = fs.realpathSync(path.resolve(project));
    insist(fs.statSync(root).isDirectory(), 'BAD_PROJECT', 'Project must be an existing directory.');
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
            insist(!fs.lstatSync(cursor).isSymbolicLink(), 'SYMLINK', `Refusing symbolic link: ${path.relative(root, cursor)}`);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    return target;
}
export function readText(file, maxBytes = 1024 * 1024) {
    const s = fs.lstatSync(file);
    insist(s.isFile() && !s.isSymbolicLink(), 'BAD_FILE', 'Expected a regular, non-symlink file.');
    insist(s.size <= maxBytes, 'INPUT_TOO_LARGE', `File exceeds ${maxBytes} bytes.`);
    const bytes = fs.readFileSync(file);
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
export const readJSON = (file, maxBytes) => parseJSON(readText(file, maxBytes), path.basename(file));
export function mkdir(root, relative) {
    const target = safePath(root, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
}
export function atomicWrite(root, relative, text, { replace = false } = {}) {
    const target = safePath(root, relative);
    mkdir(root, path.relative(root, path.dirname(target)) || '.');
    const temp = path.join(path.dirname(target), '.tmp-' + randomUUID());
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        safePath(root, relative);
        if (replace)
            fs.renameSync(temp, target);
        else {
            fs.linkSync(temp, target);
            fs.unlinkSync(temp);
        }
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
        try {
            fs.unlinkSync(temp);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
}
export async function withLock(root, relative, fn, timeoutMs = 1500) {
    const lock = safePath(root, relative);
    mkdir(root, path.relative(root, path.dirname(lock)) || '.');
    const end = Date.now() + timeoutMs;
    for (;;) {
        try {
            fs.mkdirSync(lock, { mode: 0o700 });
            break;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            insist(Date.now() < end, 'LOCKED', 'Another writer holds the lock. A crashed-writer lock requires explicit operator recovery.');
            await new Promise(r => setTimeout(r, 15));
        }
    }
    try {
        return await fn();
    }
    finally {
        fs.rmdirSync(lock);
    }
}
export function walk(root, { exclude = () => false, maxFiles = 20000 } = {}) {
    const result = [];
    function visit(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const file = path.join(dir, entry.name);
            const rel = path.relative(root, file).split(path.sep).join('/');
            if (exclude(rel, entry))
                continue;
            insist(result.length < maxFiles, 'TOO_MANY_FILES', 'Workspace file limit exceeded.');
            if (entry.isDirectory())
                visit(file);
            else if (entry.isSymbolicLink())
                result.push({ path: rel, kind: 'link', hash: sha256(fs.readlinkSync(file)) });
            else if (entry.isFile())
                result.push({ path: rel, kind: 'file', executable: fs.statSync(file).mode & 0o111, hash: sha256(readTextOrBytes(file)) });
            else
                throw new StewardError('SPECIAL_FILE', 'Workspace contains a non-regular file.');
        }
    }
    let total = 0;
    function readTextOrBytes(file) { const s = fs.statSync(file); total += s.size; insist(total <= 128 * 1024 * 1024, 'WORKSPACE_TOO_LARGE', 'Snapshot exceeds 128 MiB.'); return fs.readFileSync(file); }
    visit(root);
    return result;
}
export function snapshot(root) {
    const files = walk(root, { exclude: (p) => p === '.git' || p === 'node_modules' || p === '.steward/state' || p.startsWith('.steward/install-') });
    return { hash: sha256(canonical(files)), files: files.length, excluded: ['.git/', 'node_modules/', '.steward/state/', '.steward/install-*'] };
}
