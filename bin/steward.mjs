#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rootOf, safePath, parseJSON, readText, readJSON, toSessionHash } from '../src/fs.mjs';
import { insist, publicError, StewardError } from '../src/errors.mjs';
import { loadBundle, trustBundle } from '../src/trust.mjs';
import { handleHook } from '../src/service.mjs';
import { encode, eventKind, inferAntigravityEvent, normalizeInput } from '../src/adapters.mjs';
import { evaluate } from '../src/engine.mjs';
import { appendEntry, readJournal, journalHead, queryJournal } from '../src/journal.mjs';
import { VERSION } from '../src/version.mjs';
import { runVerification, completionGate } from '../src/verify.mjs';
import { report, pruneAudit } from '../src/audit.mjs';
import { auditInstructions } from '../src/instructions.mjs';
import { initProject, installHooks, INSTALL_HOSTS } from '../src/setup.mjs';
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
hook --host HOST       Handle JSON on stdin (generic, codex, claude, antigravity)
eval --input FILE      Evaluate an untrusted draft as a simulation; no activation
journal add --file F   Add a typed decision/question/knowledge/goal/schedule/handoff
journal list           Read the validated journal
journal query          Recall current records; --type --text --tag --since --until --limit (1–100)
                       --history includes expired/superseded; --record-id --session-id filter IDs
journal verify         Check integrity; optional --anchor-file FILE
journal anchor         Print a count/hash checkpoint to keep outside the project
checkpoint --file F    Persist {summary,next,blockers}; --session-id binds recovery
verify                 Run the exact trusted verification commands
gate                   Check latest evidence against current source and plan
report                 Count context prepared, never pretend host receipt
audit report           Alias for report
audit prune [--keep N] Prune older audit receipts to recover retention capacity
instructions-audit     Inventory agent files and flag common instruction conflicts
doctor                 Check trust and local wiring; --host codex, claude or antigravity
mcp                    Run JSON-RPC 2.0 stdio MCP server for agent integration
mcp --config           Print MCP client configuration; --host claude, cursor, codex or antigravity
keygen                 Generate an Ed25519 asymmetric key pair
sign-bundle            Sign trust bundle with --key FILE
verify-bundle          Verify signed bundle with --verifier FILE
sign-evidence          Sign verification run with --evidence HASH --key FILE
verify-evidence        Verify signed evidence with --evidence HASH --verifier FILE
version                Print Steward CLI version

Options: --host --project --input --file --approve --event --evidence --plugin
         --anchor-file --session-id --type --text --tag --since --until --limit
         --record-id --history --keep --key --key-file --verifier --public-key
         --out --config --version --help
No network calls, provider routing, daemon, automatic publishing or API keys.
`;

const CLI_STRING_OPTIONS = [
    'host', 'project', 'input', 'file', 'approve', 'event', 'evidence',
    'anchor-file', 'session-id', 'type', 'text', 'tag', 'since', 'until',
    'limit', 'record-id', 'keep', 'key', 'key-file', 'verifier', 'public-key', 'out'
];

const CLI_BOOLEAN_OPTIONS = ['help', 'plugin', 'history', 'version', 'config'];

const CLI_OPTIONS = Object.fromEntries([
    ...CLI_STRING_OPTIONS.map(k => [k, { type: 'string' }]),
    ...CLI_BOOLEAN_OPTIONS.map(k => [k, { type: 'boolean' }])
]);

let command = process.argv[2] || 'help', opts = {}, positionals = [];
// Retain the trusted registration hints even if option parsing itself fails.
for (const key of ['host', 'event']) {
    const i = process.argv.indexOf('--' + key);
    if (i >= 0) {
        opts[key] = process.argv[i + 1];
    }
}

function output(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function resolveSafePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new StewardError('USAGE', 'File path is required.');
    }
    if (filePath.includes('\0')) {
        throw new StewardError('BAD_PATH', 'Path contains null bytes.');
    }
    return path.resolve(filePath);
}

function resolveKeyOption(primary, alias) {
    if (opts[alias]) {
        return resolveSafePath(opts[alias]);
    }
    if (opts[primary] && !opts[primary].includes('-----BEGIN')) {
        return resolveSafePath(opts[primary]);
    }
    return opts[primary];
}

function requireInitializedProject(root) {
    insist(
        fs.existsSync(safePath(root, '.steward/policy.json')) && fs.existsSync(safePath(root, '.steward/verify.json')),
        'BAD_PROJECT',
        'Target project is not an initialized Steward workspace.'
    );
}

async function input() {
    const fileArg = opts.input || opts.file;
    if (fileArg) {
        return parseJSON(readText(resolveSafePath(fileArg)));
    }
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        const timer = setTimeout(() => {
            process.stdin.destroy();
            reject(new StewardError('STDIN_TIMEOUT', 'stdin timed out'));
        }, 3000);
        process.stdin.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                clearTimeout(timer);
                process.stdin.destroy();
                reject(new StewardError('INPUT_TOO_LARGE', 'input exceeds 1 MiB limit'));
            } else {
                chunks.push(chunk);
            }
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            try {
                resolve(parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            } catch (e) {
                reject(e);
            }
        });
        process.stdin.on('error', e => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

function handleKeygen() {
    const keys = generateSigningKeyPair();
    if (opts.out) {
        const outDir = resolveSafePath(opts.out);
        const saved = saveKeypair(outDir, keys);
        output({ generated: true, out: saved.out, privPath: saved.privPath, pubPath: saved.pubPath, keyId: keys.keyId });
    } else {
        output(keys);
    }
}

async function handleMcp(root) {
    if (opts.config) {
        output(formatMcpConfig({ host: opts.host || 'claude', project: root }));
    } else {
        await startMcpServer(root);
    }
}

function handleTrust(root) {
    const bundle = loadBundle(root);
    if (opts.approve) {
        output(trustBundle(root, opts.approve));
        return;
    }
    output({
        trusted: false,
        bundleHash: bundle.hash,
        review: { hash: bundle.hash, policy: bundle.policy, verification: bundle.plan },
        next: 'Review these rules and executable commands, then rerun trust --approve with the displayed hash.'
    });
}

function handleLifecycle(root) {
    if (command !== 'uninstall') {
        loadBundle(root);
    }
    const optsObj = { plugin: opts.plugin, update: command === 'update', uninstall: command === 'uninstall' };
    if (opts.host === 'all') {
        output({ hosts: INSTALL_HOSTS.map(h => installHooks(root, h, optsObj)) });
    } else {
        output(installHooks(root, opts.host, optsObj));
    }
}

async function handleHookCommand(root) {
    const host = opts.host || 'generic';
    const raw = await input();
    const expectedEvent = opts.event || null;
    if (!opts.event && raw && typeof raw === 'object' && !Array.isArray(raw)) {
        opts.event = raw.hook_event_name || raw.event || (host === 'antigravity' ? inferAntigravityEvent(raw) : null);
    }
    const { encoded } = handleHook(root, host, raw, expectedEvent);
    if (encoded.stdout) {
        process.stdout.write(encoded.stdout + '\n');
    }
    if (encoded.stderr) {
        process.stderr.write(encoded.stderr + '\n');
    }
    process.exitCode = encoded.exitCode;
}

async function handleEval(root) {
    const { policy } = loadBundle(root);
    const event = normalizeInput(opts.host || 'generic', await input(), root, opts.event || null);
    output({ ...evaluate(policy, event), simulation: true, activated: false });
}

async function handleJournal(root) {
    const sub = positionals[1] || 'list';
    if (sub === 'add') {
        const fileArg = opts.file || opts.input;
        insist(fileArg, 'USAGE', '--file is required.');
        requireInitializedProject(root);
        output(await appendEntry(root, readJSON(resolveSafePath(fileArg))));
    } else if (sub === 'list') {
        output(readJournal(root));
    } else if (sub === 'query') {
        output(queryJournal(root, {
            type: opts.type,
            text: opts.text,
            tag: opts.tag,
            since: opts.since,
            until: opts.until,
            limit: opts.limit === undefined ? 20 : Number(opts.limit),
            history: opts.history,
            recordId: opts['record-id'],
            sessionId: opts['session-id']
        }));
    } else if (sub === 'anchor') {
        output(journalHead(readJournal(root)));
    } else if (sub === 'verify') {
        const anchor = opts['anchor-file'] ? readJSON(resolveSafePath(opts['anchor-file'])) : null;
        const rows = readJournal(root, { fresh: true, anchor });
        output({ valid: true, ...journalHead(rows) });
    } else {
        insist(false, 'USAGE', 'Unknown journal command.');
    }
}

async function handleCheckpoint(root) {
    const fileArg = opts.file || opts.input;
    insist(fileArg, 'USAGE', '--file is required.');
    requireInitializedProject(root);
    const data = readJSON(resolveSafePath(fileArg));
    if (opts['session-id'] !== undefined) {
        insist(opts['session-id'].trim() && opts['session-id'].length <= 256, 'USAGE', 'Invalid session ID.');
        const session = toSessionHash(opts['session-id']);
        insist(data && typeof data === 'object' && !Array.isArray(data), 'SCHEMA', 'Checkpoint must be an object.');
        insist(data.session === undefined || data.session === session, 'USAGE', 'Checkpoint session conflicts with --session-id.');
        data.session = session;
    }
    output(await appendEntry(root, { type: 'checkpoint', data }));
}

async function handleVerify(root) {
    const r = await runVerification(root);
    output(r);
    if (!r.allPassed) {
        process.exitCode = 1;
    }
}

function handleAudit(root) {
    const sub = positionals[1] || 'report';
    if (sub === 'prune') {
        insist(opts.keep === undefined || opts.keep.trim() !== '', 'USAGE', 'keep must be a non-negative integer.');
        const keep = opts.keep === undefined ? 5000 : Number(opts.keep);
        output(pruneAudit(root, { keep }));
    } else if (sub === 'report') {
        output(report(root));
    } else {
        insist(false, 'USAGE', 'Unknown audit subcommand. Use prune or report.');
    }
}

function handleDoctor(root) {
    const result = doctor(root, opts.host || null);
    output(result);
    if (!result.localHealthy) {
        process.exitCode = 1;
    }
}

const COMMAND_HANDLERS = {
    mcp: (root) => handleMcp(root),
    'sign-bundle': (root, { keyArg }) => {
        insist(keyArg, 'USAGE', '--key or --key-file is required.');
        output(signBundle(root, keyArg));
    },
    'verify-bundle': (root, { verifierArg }) => {
        insist(verifierArg, 'USAGE', '--verifier or --public-key is required.');
        output(verifyBundleSignature(root, verifierArg));
    },
    'sign-evidence': (root, { keyArg }) => {
        insist(opts.evidence, 'USAGE', '--evidence is required.');
        insist(keyArg, 'USAGE', '--key or --key-file is required.');
        output(signVerificationEvidence(root, opts.evidence, keyArg));
    },
    'verify-evidence': (root, { verifierArg }) => {
        insist(opts.evidence, 'USAGE', '--evidence is required.');
        insist(verifierArg, 'USAGE', '--verifier or --public-key is required.');
        output(verifyVerificationEvidence(root, opts.evidence, verifierArg));
    },
    trust: (root) => handleTrust(root),
    install: (root) => handleLifecycle(root),
    update: (root) => handleLifecycle(root),
    uninstall: (root) => handleLifecycle(root),
    hook: (root) => handleHookCommand(root),
    eval: (root) => handleEval(root),
    journal: (root) => handleJournal(root),
    checkpoint: (root) => handleCheckpoint(root),
    verify: (root) => handleVerify(root),
    gate: (root) => output(completionGate(root, opts.evidence || null)),
    audit: (root) => handleAudit(root),
    report: (root) => output(report(root)),
    'instructions-audit': (root) => output(auditInstructions(root)),
    doctor: (root) => handleDoctor(root)
};

try {
    const parsed = parseArgs({ allowPositionals: true, options: CLI_OPTIONS });
    opts = parsed.values;
    positionals = parsed.positionals;
    command = positionals[0] || 'help';

    const keyArg = resolveKeyOption('key', 'key-file');
    const verifierArg = resolveKeyOption('verifier', 'public-key');

    if (opts.version || command === 'version') {
        output({ version: VERSION });
    } else if (opts.help || command === 'help') {
        console.log(HELP);
    } else if (command === 'init') {
        output(initProject(opts.project || process.cwd(), { plugin: opts.plugin }));
    } else if (command === 'keygen') {
        handleKeygen();
    } else {
        const root = rootOf(opts.project || process.cwd());
        const handler = Object.hasOwn(COMMAND_HANDLERS, command) ? COMMAND_HANDLERS[command] : null;
        insist(handler, 'USAGE', 'Unknown command. Use --help.');
        await handler(root, { keyArg, verifierArg });
    }
}
catch (error) {
    const e = publicError(error);
    if (command === 'hook') {
        const result = { decision: 'deny', error: true, reason: `Steward ${e.code}: ${e.message}`, matched: [], emitted: [], omitted: [], context: '', bytes: 0 };
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

