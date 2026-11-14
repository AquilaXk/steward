// SPDX-License-Identifier: Apache-2.0
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

const CLAUSE_NEGATION_RE = /\b(?:do not|don't|never|must not|mustn't|cannot|can't|avoid|refuse to|forbid|prohibit|without)\s+(?:[^\s.,;:!?()[\]]+\s+){0,4}$/i;
const CLAUSE_BREAK_RE = /[.,;:!?\n()[\]—–]/g;

const INSTRUCTION_ROOTS = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'procedures',
    'skills',
    '.agents/skills',
    '.claude/skills'
];

function isNegatedInClause(text, matchIndex) {
    if (matchIndex <= 0) return false;
    const windowStart = Math.max(0, matchIndex - 96);
    const slice = text.slice(windowStart, matchIndex);
    let lastBreak = -1;
    CLAUSE_BREAK_RE.lastIndex = 0;
    let m;
    while ((m = CLAUSE_BREAK_RE.exec(slice)) !== null) {
        lastBreak = m.index;
    }
    const clausePrefix = lastBreak >= 0 ? slice.slice(lastBreak + 1) : slice;
    return CLAUSE_NEGATION_RE.test(clausePrefix);
}

function scanInstructionFile(abs, relative) {
    const text = readText(abs, 256 * 1024);
    const findings = [];
    const seen = new Set();
    const lines = text.split('\n');

    const record = (code, lineNumber) => {
        const key = `${code}:${lineNumber}`;
        if (!seen.has(key)) {
            seen.add(key);
            findings.push({ code, line: lineNumber });
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [code, re] of patterns) {
            const singleMatch = re.exec(line);
            if (singleMatch && !isNegatedInClause(line, singleMatch.index)) {
                record(code, i + 1);
            }
        }
        if (i + 1 < lines.length) {
            const nextTrimmed = lines[i + 1].trimStart();
            if (nextTrimmed.length > 0) {
                const boundary = line.length;
                const joined = `${line} ${nextTrimmed}`;
                for (const [code, re] of patterns) {
                    const wrappedMatch = re.exec(joined);
                    if (
                        wrappedMatch &&
                        wrappedMatch.index <= boundary &&
                        wrappedMatch.index + wrappedMatch[0].length > boundary + 1 &&
                        !isNegatedInClause(joined, wrappedMatch.index)
                    ) {
                        record(code, i + 1);
                    }
                }
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
