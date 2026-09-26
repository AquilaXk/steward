#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rootOf, parseJSON, readText, readJSON, sha256 } from '../src/fs.mjs';
import { insist, publicError, StewardError } from '../src/errors.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { handleHook } from '../src/service.mjs';
import { encode, eventKind, normalizeInput } from '../src/adapters.mjs';
import { evaluate } from '../src/engine.mjs';
import { appendEntry, readJournal, journalHead, queryJournal } from '../src/journal.mjs';
import { VERSION } from '../src/version.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { report, pruneAudit } from '../src/audit.mjs';
import { auditInstructions } from '../src/instructions.mjs';
import { initProject, installHooks } from '../src/setup.mjs';
import { doctor } from '../src/doctor.mjs';
import { startMcpServer, formatMcpConfig } from '../src/adapters/mcp.mjs';
import { generateSigningKeyPair, signBundle, verifyBundleSignature, signVerificationEvidence, verifyVerificationEvidence, saveKeypair } from '../src/crypto.mjs';
const HELP = `Steward ${VERSION} — local agent policy and evidence toolkit
Usage: node bin/steward.mjs <command> [--project <directory>] [options]

init                   Initialize project files; --plugin uses bundled skills
trust                  Print bundle hash and commands for review
trust --approve HASH   Record approval of that exact policy/command bundle
install --host HOST    Merge local hooks; --plugin avoids copying bundled skills
update --host HOST     Refresh managed files; stop on customized skill conflicts
uninstall --host HOST  Remove owned hooks and unchanged skills; retain project data
hook --host HOST       Handle JSON on stdin (generic, codex, claude)
eval --input FILE      Evaluate an untrusted draft as a simulation; no activation
journal add --file F   Add a typed decision/question/knowledge/goal/schedule/handoff
journal list           Read the validated journal
journal query          Recall current records; --type --text --limit (1–100)
                       --history includes expired/superseded; --record-id filters ID
journal verify         Check integrity; optional --anchor-file FILE
journal anchor         Print a count/hash checkpoint to keep outside the project
checkpoint --file F    Persist {summary,next,blockers}; --session-id binds recovery
verify                 Run the exact trusted verification commands
gate                   Check latest evidence against current source and plan
report                 Count context prepared, never pretend host receipt
audit prune [--keep N] Prune older audit receipts to recover retention capacity
instructions-audit     Inventory agent files and flag common instruction conflicts
doctor                 Check trust and local wiring; --host codex or claude
mcp                    Run JSON-RPC 2.0 stdio MCP server for agent integration
mcp --config           Print MCP client configuration; --host claude, cursor or antigravity
keygen                 Generate an Ed25519 asymmetric key pair
sign-bundle            Sign trust bundle with --key FILE
verify-bundle          Verify signed bundle with --verifier FILE
sign-evidence          Sign verification run with --evidence HASH --key FILE
verify-evidence        Verify signed evidence with --evidence HASH --verifier FILE

Options: --host --project --input --file --approve --event --evidence --plugin
         --anchor-file --session-id --keep --key --key-file --verifier --public-key --out --config --help
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

function resolveSafePath(filePath) {
    insist(typeof filePath === 'string' && filePath.trim(), 'USAGE', 'File path is required.');
    insist(!filePath.includes('\0'), 'BAD_PATH', 'Path contains null bytes.');
    const resolved = path.resolve(filePath);
    insist(path.isAbsolute(resolved), 'BAD_PATH', 'Path must resolve to an absolute path.');
    return resolved;
}

async function input() {
    if (opts.input)
        return parseJSON(readText(resolveSafePath(opts.input)));
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        const timer = setTimeout(() => { process.stdin.destroy(); reject(new StewardError('STDIN_TIMEOUT', 'stdin timed out')); }, 3000);
        process.stdin.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                clearTimeout(timer);
                process.stdin.destroy();
                reject(new StewardError('INPUT_TOO_LARGE', 'input exceeds 1 MiB limit'));
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
    const parsed = parseArgs({ allowPositionals: true, options: Object.fromEntries(['host', 'project', 'input', 'file', 'approve', 'event', 'evidence', 'anchor-file', 'session-id', 'type', 'text', 'limit', 'record-id', 'keep', 'key', 'key-file', 'verifier', 'public-key', 'out'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['plugin', { type: 'boolean' }], ['history', { type: 'boolean' }], ['version', { type: 'boolean' }], ['config', { type: 'boolean' }]])) });
    opts = parsed.values;
    positionals = parsed.positionals;
    command = positionals[0] || 'help';
    const keyArg = opts.key || opts['key-file'];
    const verifierArg = opts.verifier || opts['public-key'];
    if (opts.version || command === 'version') output({ version: VERSION });
    else if (opts.help || command === 'help') {
        console.log(HELP);
    }
    else if (command === 'init') {
        output(initProject(opts.project || process.cwd(), { plugin: opts.plugin }));
    }
    else if (command === 'keygen') {
        const keys = generateSigningKeyPair();
        if (opts.out) {
            const outDir = resolveSafePath(opts.out);
            const saved = saveKeypair(outDir, keys);
            output({ generated: true, out: saved.out, keyId: keys.keyId });
        } else {
            output(keys);
        }
    }
    else {
        const root = rootOf(opts.project || process.cwd());
        if (command === 'mcp') {
            if (opts.config) {
                output(formatMcpConfig({ host: opts.host || 'claude', project: root }));
            } else {
                await startMcpServer(root);
            }
        }
        else if (command === 'sign-bundle') {
            insist(keyArg, 'USAGE', '--key or --key-file is required.');
            output(signBundle(root, keyArg));
        }
        else if (command === 'verify-bundle') {
            insist(verifierArg, 'USAGE', '--verifier or --public-key is required.');
            output(verifyBundleSignature(root, verifierArg));
        }
        else if (command === 'sign-evidence') {
            insist(opts.evidence, 'USAGE', '--evidence is required.');
            insist(keyArg, 'USAGE', '--key or --key-file is required.');
            output(signVerificationEvidence(root, opts.evidence, keyArg));
        }
        else if (command === 'verify-evidence') {
            insist(opts.evidence, 'USAGE', '--evidence is required.');
            insist(verifierArg, 'USAGE', '--verifier or --public-key is required.');
            output(verifyVerificationEvidence(root, opts.evidence, verifierArg));
        }
        else if (command === 'trust') {
            const bundle = loadBundle(root);
            output(opts.approve ? trustBundle(root, opts.approve) : { trusted: false, review: { hash: bundle.hash, policy: bundle.policy, verification: bundle.plan }, next: 'Review these rules and executable commands, then rerun trust --approve with the displayed hash.' });
        }
        else if (['install', 'update', 'uninstall'].includes(command)) {
            if (command !== 'uninstall') loadBundle(root);
            output(installHooks(root, opts.host, { plugin: opts.plugin, update: command === 'update', uninstall: command === 'uninstall' }));
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
                output(await appendEntry(root, readJSON(resolveSafePath(opts.file))));
            }
            else if (sub === 'list')
                output(readJournal(root));
            else if (sub === 'query')
                output(queryJournal(root, { type: opts.type, text: opts.text, limit: opts.limit === undefined ? 20 : Number(opts.limit), history: opts.history, recordId: opts['record-id'], sessionId: opts['session-id'] }));
            else if (sub === 'anchor')
                output(journalHead(readJournal(root)));
            else if (sub === 'verify') {
                const rows = readJournal(root, { anchor: opts['anchor-file'] ? readJSON(resolveSafePath(opts['anchor-file'])) : null });
                output({ valid: true, ...journalHead(rows) });
            }
            else
                insist(false, 'USAGE', 'Unknown journal command.');
        }
        else if (command === 'checkpoint') {
            insist(opts.file, 'USAGE', '--file is required.');
            const data = readJSON(resolveSafePath(opts.file));
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
        else if (command === 'audit') {
            const sub = positionals[1] || 'report';
            if (sub === 'prune') {
                const keep = opts.keep === undefined ? 5000 : Number(opts.keep);
                output(pruneAudit(root, { keep }));
            }
            else if (sub === 'report')
                output(report(root));
            else
                insist(false, 'USAGE', 'Unknown audit subcommand. Use prune or report.');
        }
        else if (command === 'report')
            output(report(root));
        else if (command === 'instructions-audit')
            output(auditInstructions(root));
        else if (command === 'doctor') {
            const result = doctor(root, opts.host || null);
            output(result);
            if (!result.localHealthy) process.exitCode = 1;
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
