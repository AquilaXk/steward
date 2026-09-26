#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

console.log(`Preparing release verification for ${pkg.name}@${pkg.version}...`);

/**
 * Resolves the npm CLI executable path with fixed resolution to prevent unrestricted PATH lookups.
 */
function resolveNpm() {
    if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
        return { file: process.execPath, prefixArgs: [process.env.npm_execpath] };
    }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const candidate = path.resolve(dir, npmCmd);
        try {
            if (fs.existsSync(candidate)) {
                return { file: candidate, prefixArgs: [] };
            }
        } catch {}
    }
    return { file: npmCmd, prefixArgs: [] };
}

const npm = resolveNpm();

// Ensure syntax check and tests pass first
execFileSync(npm.file, [...npm.prefixArgs, 'run', 'verify'], { cwd: root, stdio: 'inherit' });

// Verify npm pack dry-run output
const packStdout = execFileSync(npm.file, [...npm.prefixArgs, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
const packInfo = JSON.parse(packStdout)[0];
console.log(`Package tarball: ${packInfo.filename} (${packInfo.size} bytes, ${packInfo.entryCount} files)`);

const bundledFiles = packInfo.files.map(f => f.path);
assert(bundledFiles.includes('index.d.ts'), 'index.d.ts missing from tarball');
assert(bundledFiles.includes('src/index.mjs'), 'src/index.mjs missing from tarball');
assert(bundledFiles.includes('src/adapters/mcp.mjs'), 'src/adapters/mcp.mjs missing from tarball');
assert(bundledFiles.includes('src/matcher.mjs'), 'src/matcher.mjs missing from tarball');
assert(bundledFiles.includes('src/crypto.mjs'), 'src/crypto.mjs missing from tarball');
assert(bundledFiles.includes('bin/steward.mjs'), 'bin/steward.mjs missing from tarball');

console.log('Release package contents verified successfully.');
