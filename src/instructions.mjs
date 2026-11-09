import * as fs from 'node:fs';
import path from 'node:path';
import { safePath, readText, sha256, canonical, rootOf, compareAscii } from './fs.mjs';
const patterns = [
    ['approval-stall', /always (?:ask|wait for).{0,25}(?:permission|approval)/i],
    ['unbounded-tests', /(?:run all tests after every|repeat.{0,20}tests until perfect)/i],
    ['suppressed-failure', /(?:hide|suppress|silently ignore).{0,25}(?:failures|errors)/i],
    ['hierarchy-conflict', /user instructions.{0,20}override.{0,20}system/i],
    ['private-reasoning', /(?:reveal|print|show).{0,20}(?:hidden chain|private chain)/i]
];
const INSTRUCTION_ROOTS = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'procedures',
    'skills',
    '.agents/skills',
    '.claude/skills'
];
function scanInstructionFile(abs, relative) {
    const text = readText(abs, 256 * 1024);
    const findings = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [code, re] of patterns) {
            if (re.test(line)) {
                findings.push({ code, line: i + 1 });
            }
        }
    }
    return {
        path: relative.split(path.sep).join('/'),
        sha256: sha256(text),
        bytes: Buffer.byteLength(text),
        findings
    };
}
export function auditInstructions(root) {
    root = rootOf(root);
    const files = [];
    function visit(relative, depth = 0) {
        if (depth > 12) return;
        const abs = safePath(root, relative);
        if (!fs.existsSync(abs)) return;
        if (fs.lstatSync(abs).isDirectory()) {
            const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name));
            for (const entry of entries) {
                if (!['node_modules', '.git', 'state'].includes(entry.name)) {
                    visit(path.join(relative, entry.name), depth + 1);
                }
            }
        } else if (/(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$/.test(relative)) {
            files.push(scanInstructionFile(abs, relative));
        }
    }
    for (const target of INSTRUCTION_ROOTS) {
        visit(target);
    }
    const findingCount = files.reduce((n, f) => n + f.findings.length, 0);
    return {
        files,
        inventoryHash: sha256(canonical(files)),
        findingCount,
        completeSecurityReview: false
    };
}
