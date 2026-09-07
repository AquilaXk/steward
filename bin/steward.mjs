#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rootOf, parseJSON, readText, readJSON, sha256 } from '../src/fs.mjs';
import { insist, publicError } from '../src/errors.mjs';
import { loadBundle, trustBundle, requireTrust } from '../src/trust.mjs';
import { handleHook } from '../src/service.mjs';
import { encode, eventKind, normalizeInput } from '../src/adapters.mjs';
import { evaluate } from '../src/engine.mjs';
import { appendEntry, readJournal, journalHead } from '../src/journal.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { report } from '../src/audit.mjs';
import { auditInstructions } from '../src/instructions.mjs';
import { initProject, installHooks } from '../src/setup.mjs';
const HELP = `Steward 0.1.1 — local agent policy and evidence toolkit
Usage: node bin/steward.mjs <command> [--project <directory>] [options]

init                   Initialize project files without replacing existing files
trust                  Print bundle hash and commands for review
trust --approve HASH   Record approval of that exact policy/command bundle
install --host HOST    Merge local hooks for codex or claude
hook --host HOST       Handle JSON on stdin (generic, codex, claude)
eval --input FILE      Evaluate an untrusted draft as a simulation; no activation
journal add --file F   Add a typed decision/question/knowledge/goal/schedule/handoff
journal list           Read the validated journal
journal verify         Check integrity; optional --anchor-file FILE
journal anchor         Print a count/hash checkpoint to keep outside the project
checkpoint --file F    Persist {summary,next,blockers}; --session-id binds recovery
verify                 Run the exact trusted verification commands
gate                   Check latest evidence against current source and plan
report                 Count context prepared, never pretend host receipt
instructions-audit     Inventory agent files and flag common instruction conflicts
doctor                 Check trusted policy, journal and instruction inventory

Options: --host --project --input --file --approve --event --evidence
         --anchor-file --session-id --help
No network calls, provider routing, daemon, automatic publishing or API keys.
`;
let command = process.argv[2] || 'help', opts = {}, positionals = [];
// Retain the trusted registration hints even if option parsing itself fails.
for (const key of ['host', 'event']) {
    const i = process.argv.indexOf('--' + key);
    if (i >= 0)
        opts[key] = process.argv[i + 1];
}
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
async function input() {
    if (opts.input)
        return parseJSON(readText(path.resolve(opts.input)));
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error('stdin timed out')); }, 3000);
        process.stdin.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                clearTimeout(timer);
                process.stdin.destroy();
                reject(new Error('input too large'));
            }
            else
                chunks.push(chunk);
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            try {
                resolve(parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            }
            catch (e) {
                reject(e);
            }
        });
        process.stdin.on('error', e => { clearTimeout(timer); reject(e); });
    });
}
try {
    const parsed = parseArgs({ allowPositionals: true, options: Object.fromEntries(['host', 'project', 'input', 'file', 'approve', 'event', 'evidence', 'anchor-file', 'session-id'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
    opts = parsed.values;
    positionals = parsed.positionals;
    command = positionals[0] || 'help';
    if (opts.help || command === 'help') {
        console.log(HELP);
    }
    else if (command === 'init') {
        output(initProject(opts.project || process.cwd()));
    }
    else {
        const root = rootOf(opts.project || process.cwd());
        if (command === 'trust') {
            const bundle = loadBundle(root);
            output(opts.approve ? trustBundle(root, opts.approve) : { trusted: false, review: { hash: bundle.hash, policy: bundle.policy, verification: bundle.plan }, next: 'Review these rules and executable commands, then rerun trust --approve with the displayed hash.' });
        }
        else if (command === 'install') {
            loadBundle(root);
            output(installHooks(root, opts.host));
        }
        else if (command === 'hook') {
            const host = opts.host || 'generic';
            const { encoded } = handleHook(root, host, await input(), opts.event || null);
            if (encoded.stdout)
                process.stdout.write(encoded.stdout + '\n');
            if (encoded.stderr)
                process.stderr.write(encoded.stderr + '\n');
            process.exitCode = encoded.exitCode;
        }
        else if (command === 'eval') {
            const { policy } = loadBundle(root);
            const event = normalizeInput(opts.host || 'generic', await input(), root, opts.event || null);
            output({ ...evaluate(policy, event), simulation: true, activated: false });
        }
        else if (command === 'journal') {
            const sub = positionals[1] || 'list';
            if (sub === 'add') {
                insist(opts.file, 'USAGE', '--file is required.');
                output(await appendEntry(root, readJSON(path.resolve(opts.file))));
            }
            else if (sub === 'list')
                output(readJournal(root));
            else if (sub === 'anchor')
                output(journalHead(readJournal(root)));
            else if (sub === 'verify') {
                const rows = readJournal(root, { anchor: opts['anchor-file'] ? readJSON(path.resolve(opts['anchor-file'])) : null });
                output({ valid: true, ...journalHead(rows) });
            }
            else
                insist(false, 'USAGE', 'Unknown journal command.');
        }
        else if (command === 'checkpoint') {
            insist(opts.file, 'USAGE', '--file is required.');
            const data = readJSON(path.resolve(opts.file));
            if (opts['session-id'] !== undefined) {
                insist(opts['session-id'].trim() && opts['session-id'].length <= 256, 'USAGE', 'Invalid session ID.');
                const session = sha256(opts['session-id']);
                insist(data && typeof data === 'object' && !Array.isArray(data), 'SCHEMA', 'Checkpoint must be an object.');
                insist(data.session === undefined || data.session === session, 'USAGE', 'Checkpoint session conflicts with --session-id.');
                data.session = session;
            }
            output(await appendEntry(root, { type: 'checkpoint', data }));
        }
        else if (command === 'verify') {
            const r = await runVerification(root);
            output(r);
            if (!r.allPassed)
                process.exitCode = 1;
        }
        else if (command === 'gate')
            output(completionGate(root, opts.evidence || null));
        else if (command === 'report')
            output(report(root));
        else if (command === 'instructions-audit')
            output(auditInstructions(root));
        else if (command === 'doctor') {
            const b = requireTrust(root);
            const rows = readJournal(root);
            output({ healthy: true, bundleHash: b.hash, journal: journalHead(rows), instructions: auditInstructions(root), liveHostVerified: false });
        }
        else
            insist(false, 'USAGE', 'Unknown command. Use --help.');
    }
}
catch (error) {
    const e = publicError(error);
    if (command === 'hook') {
        const result = { decision: 'deny', reason: `Steward ${e.code}: ${e.message}`, matched: [], emitted: [], omitted: [], context: '', bytes: 0 };
        const encoded = encode(opts.host || 'generic', eventKind(opts.event), result);
        if (encoded.stdout)
            process.stdout.write(encoded.stdout + '\n');
        if (encoded.stderr)
            process.stderr.write(encoded.stderr + '\n');
        process.exitCode = encoded.exitCode;
    }
    else {
        process.stderr.write(JSON.stringify({ ok: false, error: e }) + '\n');
        process.exitCode = 1;
    }
}
