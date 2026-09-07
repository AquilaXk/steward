#!/usr/bin/env node
// Static package checks. Runtime behavior is covered by npm test.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { validatePolicy, validatePlan, validateEntry } from '../src/schema.mjs';
import { validateEvent } from '../src/engine.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
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
    assert.equal(pkg.version, lock.version);
    assert.equal(pkg.version, lock.packages[''].version);
    assert.equal(pkg.name, lock.name);
    assert.equal(pkg.private, true, 'Publishing must be deliberate.');
    assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
    assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
    assert.equal(Object.keys(lock.packages).length, 1, 'Unexpected third-party package.');
    assert(read('bin/steward.mjs').startsWith('#!/usr/bin/env node'));
    const skills = all.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file));
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
    assert.equal(json('profiles/agent-workflow.json').apiIntegration, false);
    const rubric = json('evals/agent-workflow.json');
    assert.equal(rubric.status, 'not_run_on_live_model');
    assert.equal(rubric.cases.length, 18);
    assert.equal(new Set(rubric.cases.map(item => item.id)).size, rubric.cases.length);
    assert.equal(read('CLAUDE.md').trim(), '@AGENTS.md');
    for (const file of ['README.md', 'README.ko.md', 'SECURITY.md', 'docs/MODEL-GUIDANCE.md', '.github/workflows/ci.yml'])
        assert(read(file).trim());
    // Check local Markdown file links. Fragment-only links and external URLs are outside this check.
    let localLinks = 0;
    for (const file of all.filter((name) => name.endsWith('.md'))) {
        for (const match of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = match[1].split('#')[0];
            if (!target || /^(https?:|mailto:)/.test(target))
                continue;
            assert(fs.existsSync(path.resolve(root, path.dirname(file), target)), `Broken local link in ${file}: ${target}`);
            localLinks++;
        }
    }
    console.log(JSON.stringify({ pass: true, node: process.version, syntaxModules: modules.length, jsonFiles: jsonFiles.length, skills: skills.length, localLinks, dependencyCount: 0 }, null, 2));
}
catch (error) {
    console.error(JSON.stringify({ pass: false, message: error.message }, null, 2));
    process.exitCode = 1;
}
