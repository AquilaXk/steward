#!/usr/bin/env node
// Static package checks. Runtime behavior is covered by npm test.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { validatePolicy, validatePlan, validateEntry, RECORD_TYPES } from '../src/schema.mjs';
import { validateEvent } from '../src/engine.mjs';
import { claudeArtifacts } from '../src/skills.mjs';
import { VERSION } from '../src/version.mjs';
import * as publicApi from '../src/index.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
function headingSlugs(markdown) {
    const slugs = new Set();
    const counts = new Map();
    for (const line of markdown.split(/\r?\n/)) {
        const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const base = m[1]
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .trim()
            .replace(/\s+/g, '-');
        if (!base) continue;
        const seen = counts.get(base) || 0;
        counts.set(base, seen + 1);
        slugs.add(seen === 0 ? base : `${base}-${seen}`);
    }
    return slugs;
}
function files(directory = '') {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
        .filter((entry) => !['.git', 'node_modules', '.steward', 'evidence'].includes(entry.name))
        .flatMap((entry) => {
        const relative = path.posix.join(directory, entry.name);
        assert(!entry.isSymbolicLink(), `Unexpected package symlink: ${relative}`);
        return entry.isDirectory() ? files(relative) : [relative];
    });
}
try {
    assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer is required.');
    const all = files();
    const modules = all.filter((file) => file.endsWith('.mjs'));
    for (const file of modules) {
        const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, `Syntax check failed: ${file}\n${result.stderr || result.error || ''}`);
    }
    const jsonFiles = all.filter((file) => file.endsWith('.json'));
    for (const file of jsonFiles)
        json(file);
    for (const file of ['profiles/default-policy.json', 'examples/policies/protected-memory.json'])
        validatePolicy(json(file));
    validatePlan(json('profiles/default-verify.json'));
    validateEntry(json('examples/decision.json'));
    validateEntry(json('examples/goal.json'));
    validateEntry({ type: 'checkpoint', data: json('examples/checkpoint.json') });
    validateEvent(json('examples/event.json'));
    const pkg = json('package.json'), lock = json('package-lock.json');
    assert.equal(pkg.name, 'steward');
    assert.equal(VERSION, pkg.version);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert(read('CHANGELOG.md').includes(`## ${VERSION}\n`), 'Current release needs a changelog entry.');
    assert.equal(pkg.version, lock.version);
    assert.equal(pkg.version, lock.packages[''].version);
    assert.equal(pkg.name, lock.name);
    assert.equal(pkg.private, true, 'Publishing must be deliberate.');
    assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
    assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
    assert.equal(Object.keys(lock.packages).length, 1, 'Unexpected third-party package.');
    for (const host of ['codex', 'claude']) {
        const manifest = json(`.${host}-plugin/plugin.json`);
        assert.equal(manifest.name, pkg.name);
        assert.equal(manifest.version, pkg.version, 'Plugin and package versions must agree.');
        assert.equal(manifest.skills, host === 'codex' ? './procedures/' : './.claude-plugin/skills/');
    }
    const codexMarketplace = json('.agents/plugins/marketplace.json');
    const claudeMarketplace = json('.claude-plugin/marketplace.json');
    for (const marketplace of [codexMarketplace, claudeMarketplace]) {
        assert.equal(marketplace.name, pkg.name);
        assert.equal(marketplace.plugins.length, 1);
        assert.equal(marketplace.plugins[0].name, pkg.name);
    }
    assert.equal(codexMarketplace.plugins[0].source.path, './');
    assert.equal(claudeMarketplace.plugins[0].source, './');
    assert(read('bin/steward.mjs').startsWith('#!/usr/bin/env node'));
    const skills = all.filter((file) => /^procedures\/[^/]+\/SKILL\.md$/.test(file));
    const artifacts = claudeArtifacts(root);
    assert.equal(all.filter(f => f.startsWith('.claude-plugin/skills/')).length, artifacts.length);
    for (const { relative, body } of artifacts) assert.equal(read(relative), body, `Stale generated skill; run npm run build:skills: ${relative}`);
    assert.equal(skills.length, 8);
    for (const file of skills) {
        const body = read(file);
        assert(/^---\r?\nname: steward-/m.test(body), `Missing skill frontmatter: ${file}`);
        const name = /^name: (.+)$/m.exec(body)?.[1];
        const description = /^description: (.+)$/m.exec(body)?.[1];
        assert.equal(name, path.posix.basename(path.posix.dirname(file)), `Skill directory/name mismatch: ${file}`);
        assert(description && description.length <= 1024, `Invalid skill description: ${file}`);
        assert(body.split('\n').length <= 100, `Skill is no longer a compact procedure: ${file}`);
    }
    for (const file of ['policy', 'verification', 'event', 'journal-entry']) {
        const schema = json(`schemas/${file}.schema.json`);
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert(schema.$id.startsWith('urn:steward:'));
    }
    const dts = read('index.d.ts');
    for (const symbolName of Object.keys(publicApi)) {
        assert.match(dts, new RegExp(`export\\s+(?:declare\\s+)?(?:const|function|class)\\s+${symbolName}\\b`), `Missing symbol in index.d.ts: ${symbolName}`);
    }
    const journalSchema = json('schemas/journal-entry.schema.json');
    assert.deepEqual(journalSchema.oneOf.map(b => b.properties.type.const), RECORD_TYPES, 'Journal entry schema types drifted from RECORD_TYPES.');
    for (const branch of journalSchema.oneOf) {
        assert(branch.properties.data.properties.tags, `Missing tags in schemas/journal-entry.schema.json for ${branch.properties.type.const}`);
    }
    const workflowProfile = json('profiles/agent-workflow.json');
    assert.equal(workflowProfile.apiIntegration, false);
    assert.deepEqual(workflowProfile.modelReferences?.tiers, ['tier-reasoning', 'tier-coding', 'tier-fast'], 'Expected vendor-neutral model tiers in profiles/agent-workflow.json.');
    const rubric = json('evals/agent-workflow.json');
    assert.equal(rubric.status, 'not_run_on_live_model');
    assert.equal(rubric.cases.length, 19);
    assert.equal(new Set(rubric.cases.map(item => item.id)).size, rubric.cases.length);
    assert.equal(read('CLAUDE.md').trim(), '@AGENTS.md');
    for (const file of ['README.md', 'README.ko.md', 'SECURITY.md', 'docs/MODEL-GUIDANCE.md', '.github/workflows/ci.yml', '.github/workflows/automerge.yml', '.github/workflows/release.yml'])
        assert(read(file).trim());
    // Check local Markdown file links and #fragment heading anchors.
    let localLinks = 0;
    const slugCache = new Map();
    const getSlugs = (absPath) => {
        if (!slugCache.has(absPath)) slugCache.set(absPath, headingSlugs(fs.readFileSync(absPath, 'utf8')));
        return slugCache.get(absPath);
    };
    for (const file of all.filter((name) => name.endsWith('.md'))) {
        const absCurrent = path.resolve(root, file);
        for (const match of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
            const rawHref = match[1];
            if (/^(https?:|mailto:|file:|conversation:)/.test(rawHref))
                continue;
            const [target, fragment] = rawHref.split('#');
            const resolvedTarget = target ? path.resolve(root, path.dirname(file), target) : absCurrent;
            assert(fs.existsSync(resolvedTarget), `Broken local link in ${file}: ${rawHref}`);
            if (fragment && resolvedTarget.endsWith('.md') && fs.statSync(resolvedTarget).isFile()) {
                const slugs = getSlugs(resolvedTarget);
                assert(slugs.has(decodeURIComponent(fragment).toLowerCase()), `Broken markdown anchor in ${file}: ${rawHref}`);
            }
            localLinks++;
        }
    }
    const delivery = json('evidence/delivery.json');
    assert.equal(delivery.package, pkg.name);
    assert.equal(delivery.version, pkg.version, 'evidence/delivery.json version drifted from package.json.');
    assert.equal(delivery.tests.fail, 0);
    assert.equal(delivery.tests.tests, delivery.tests.pass);
    const checkEvidence = json('evidence/check-results.json');
    assert.equal(checkEvidence.result.pass, true);
    assert.equal(checkEvidence.result.syntaxModules, modules.length, 'evidence/check-results.json syntaxModules drifted.');
    assert.equal(checkEvidence.result.jsonFiles, jsonFiles.length, 'evidence/check-results.json jsonFiles drifted.');
    assert.equal(checkEvidence.result.skills, skills.length, 'evidence/check-results.json skills drifted.');
    assert.equal(checkEvidence.result.localLinks, localLinks, 'evidence/check-results.json localLinks drifted.');
    const sourceManifest = json('evidence/source-manifest.json');
    assert.equal(sourceManifest.version, 1);
    assert.deepEqual(sourceManifest.files.map((item) => item.path), [...all].sort(), 'evidence/source-manifest.json file list drifted.');
    for (const item of sourceManifest.files) {
        const buf = fs.readFileSync(path.join(root, item.path));
        assert.equal(buf.byteLength, item.bytes, `evidence/source-manifest.json byte length mismatch: ${item.path}`);
        assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), item.sha256, `evidence/source-manifest.json sha256 mismatch: ${item.path}`);
    }
    const fullManifest = json('evidence/manifest.json');
    assert.equal(fullManifest.version, 1);
    for (const item of fullManifest.files) {
        const buf = fs.readFileSync(path.join(root, item.path));
        assert.equal(buf.byteLength, item.bytes, `evidence/manifest.json byte length mismatch: ${item.path}`);
        assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), item.sha256, `evidence/manifest.json sha256 mismatch: ${item.path}`);
    }
    console.log(JSON.stringify({ pass: true, node: process.version, syntaxModules: modules.length, jsonFiles: jsonFiles.length, skills: skills.length, localLinks, dependencyCount: 0 }, null, 2));
}
catch (error) {
    console.error(JSON.stringify({ pass: false, message: error.message }, null, 2));
    process.exitCode = 1;
}
