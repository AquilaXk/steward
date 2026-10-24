#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const shouldPack = process.argv.includes('--pack');

const expectedTag = `v${pkg.version}`;
const releaseTag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_NAME?.startsWith('v') ? process.env.GITHUB_REF_NAME : null);
if (releaseTag) {
    assert.equal(releaseTag, expectedTag, `Release tag ${releaseTag} does not match package.json version (${expectedTag}).`);
}

console.log(`Preparing release verification for ${pkg.name}@${pkg.version}...`);

function findCoLocatedNpm(nodeDir, npmCmd) {
    const npmCliCandidate = path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js');
    if (fs.existsSync(npmCliCandidate)) {
        return { file: process.execPath, prefixArgs: [npmCliCandidate] };
    }
    const npmCliAlt = path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js');
    if (fs.existsSync(npmCliAlt)) {
        return { file: process.execPath, prefixArgs: [npmCliAlt] };
    }
    const coLocatedNpm = path.join(nodeDir, npmCmd);
    if (fs.existsSync(coLocatedNpm)) {
        return { file: coLocatedNpm, prefixArgs: [] };
    }
    return null;
}

function findPathNpm(npmCmd) {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const candidate = path.resolve(dir, npmCmd);
        try {
            if (fs.existsSync(candidate) && path.isAbsolute(candidate)) {
                return { file: candidate, prefixArgs: [] };
            }
        } catch {}
    }
    return null;
}

function resolveNpm() {
    if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
        return { file: process.execPath, prefixArgs: [process.env.npm_execpath] };
    }
    const nodeDir = path.dirname(process.execPath);
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const coLocated = findCoLocatedNpm(nodeDir, npmCmd);
    if (coLocated) return coLocated;

    const fixedCandidates = process.platform === 'win32'
        ? [
            String.raw`C:\Program Files\nodejs\npm.cmd`,
            String.raw`C:\Program Files (x86)\nodejs\npm.cmd`
        ]
        : [
            '/usr/local/bin/npm',
            '/usr/bin/npm',
            '/opt/homebrew/bin/npm'
        ];
    for (const candidate of fixedCandidates) {
        try {
            if (fs.existsSync(candidate)) {
                return { file: candidate, prefixArgs: [] };
            }
        } catch {}
    }

    const fromPath = findPathNpm(npmCmd);
    if (fromPath) return fromPath;

    throw new Error('Could not resolve npm executable at a fixed or trusted path.');
}

const npm = resolveNpm();
assert(path.isAbsolute(npm.file), 'npm executable path must be absolute.');

execFileSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/test.mjs')], { cwd: root, stdio: 'inherit' });

const packStdout = execFileSync(npm.file, [...npm.prefixArgs, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
const packInfo = JSON.parse(packStdout)[0];
console.log(`Package tarball: ${packInfo.filename} (${packInfo.size} bytes, ${packInfo.entryCount} files)`);

const bundledFiles = new Set(packInfo.files.map(f => f.path));
assert(bundledFiles.has('index.d.ts'), 'index.d.ts missing from tarball');
assert(bundledFiles.has('src/index.mjs'), 'src/index.mjs missing from tarball');
assert(bundledFiles.has('src/adapters/mcp.mjs'), 'src/adapters/mcp.mjs missing from tarball');
assert(bundledFiles.has('src/matcher.mjs'), 'src/matcher.mjs missing from tarball');
assert(bundledFiles.has('src/crypto.mjs'), 'src/crypto.mjs missing from tarball');
assert(bundledFiles.has('bin/steward.mjs'), 'bin/steward.mjs missing from tarball');

if (shouldPack) {
    const originalPkgRaw = fs.readFileSync(pkgPath, 'utf8');
    try {
        const publishablePkg = { ...pkg };
        delete publishablePkg.private;
        fs.writeFileSync(pkgPath, JSON.stringify(publishablePkg, null, 2) + '\n', 'utf8');
        execFileSync(npm.file, [...npm.prefixArgs, 'pack', '--quiet'], { cwd: root, stdio: 'inherit' });
    } finally {
        fs.writeFileSync(pkgPath, originalPkgRaw, 'utf8');
    }
    const tarballPath = path.join(root, packInfo.filename);
    assert(fs.existsSync(tarballPath), `Expected packed tarball at ${tarballPath}`);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
    const checksumPath = `${tarballPath}.sha256`;
    fs.writeFileSync(checksumPath, `${digest}  ${packInfo.filename}\n`, 'utf8');
    console.log(`Wrote SHA-256 checksum: ${path.basename(checksumPath)} (${digest})`);
}

console.log('Release package contents verified successfully.');
