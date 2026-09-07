import * as fs from 'node:fs';
import path from 'node:path';
import { safePath, readText, sha256, canonical } from './fs.mjs';
const patterns = [
    ['approval-stall', /always (?:ask|wait for).{0,25}(?:permission|approval)/i],
    ['unbounded-tests', /(?:run all tests after every|repeat.{0,20}tests until perfect)/i],
    ['suppressed-failure', /(?:hide|suppress|silently ignore).{0,25}(?:failures|errors)/i],
    ['hierarchy-conflict', /user instructions.{0,20}override.{0,20}system/i],
    ['private-reasoning', /(?:reveal|print|show).{0,20}(?:hidden chain|private chain)/i]
];
export function auditInstructions(root) {
    const files = [];
    function visit(relative, depth = 0) {
        if (depth > 12)
            return;
        const abs = safePath(root, relative);
        if (!fs.existsSync(abs))
            return;
        if (fs.lstatSync(abs).isDirectory()) {
            for (const e of fs.readdirSync(abs, { withFileTypes: true }))
                if (!['node_modules', '.git', 'state'].includes(e.name))
                    visit(path.join(relative, e.name), depth + 1);
        }
        else if (/(?:AGENTS|CLAUDE|SKILL)\.md$/.test(relative)) {
            const text = readText(abs, 256 * 1024), findings = [];
            text.split('\n').forEach((line, i) => {
                for (const [code, re] of patterns)
                    if (re.test(line))
                        findings.push({ code, line: i + 1 });
            });
            files.push({ path: relative.split(path.sep).join('/'), sha256: sha256(text), bytes: Buffer.byteLength(text), findings });
        }
    }
    for (const p of ['AGENTS.md', 'CLAUDE.md', 'skills', '.agents/skills', '.claude/skills'])
        visit(p);
    return { files, inventoryHash: sha256(canonical(files)), findingCount: files.reduce((n, f) => n + f.findings.length, 0), completeSecurityReview: false };
}
