import * as fs from 'node:fs';
import path from 'node:path';
import { compareAscii } from './matcher.mjs';

export function claudeSkill(body, name) {
    return ['steward-policy', 'steward-schedule'].includes(name) ?
        body.replace(/^---\r?\n/, '---\ndisable-model-invocation: true\n') : body;
}

export function claudeArtifacts(root) {
    return fs.readdirSync(path.join(root, 'procedures')).sort(compareAscii).map(name => ({
        relative: `.claude-plugin/skills/${name}/SKILL.md`,
        body: claudeSkill(fs.readFileSync(path.join(root, 'procedures', name, 'SKILL.md'), 'utf8'), name),
    }));
}

export function antigravityArtifacts(root) {
    return fs.readdirSync(path.join(root, 'procedures')).sort(compareAscii).map(name => ({
        relative: `skills/${name}/SKILL.md`,
        body: fs.readFileSync(path.join(root, 'procedures', name, 'SKILL.md'), 'utf8'),
    }));
}
