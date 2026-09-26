#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

console.log(`Preparing release verification for ${pkg.name}@${pkg.version}...`);

// Ensure syntax check and tests pass first
const verify = spawnSync('npm', ['run', 'verify'], { cwd: root, stdio: 'inherit' });
assert.equal(verify.status, 0, 'Pre-release verification failed.');

// Verify npm pack dry-run output
const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
assert.equal(pack.status, 0, `npm pack --dry-run failed: ${pack.stderr}`);

const packInfo = JSON.parse(pack.stdout)[0];
console.log(`Package tarball: ${packInfo.filename} (${packInfo.size} bytes, ${packInfo.entryCount} files)`);

const bundledFiles = packInfo.files.map(f => f.path);
assert(bundledFiles.includes('index.d.ts'), 'index.d.ts missing from tarball');
assert(bundledFiles.includes('src/index.mjs'), 'src/index.mjs missing from tarball');
assert(bundledFiles.includes('src/adapters/mcp.mjs'), 'src/adapters/mcp.mjs missing from tarball');
assert(bundledFiles.includes('src/matcher.mjs'), 'src/matcher.mjs missing from tarball');
assert(bundledFiles.includes('src/crypto.mjs'), 'src/crypto.mjs missing from tarball');
assert(bundledFiles.includes('bin/steward.mjs'), 'bin/steward.mjs missing from tarball');

console.log('Release package contents verified successfully.');
