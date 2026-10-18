import * as fs from 'node:fs';
import path from 'node:path';
import { safePath, readJSON, rootOf } from './fs.mjs';
import { insist, publicError } from './errors.mjs';
import { loadBundle, requireTrust } from './trust.mjs';
import { readJournal, journalHead } from './journal.mjs';
import { auditInstructions } from './instructions.mjs';
import { HOOK_EVENTS, INSTALL_HOSTS, hostConfigPath, hookCommand, PACKAGE_ROOT } from './setup.mjs';

function findMatchingHooks(groups, command) {
    if (!Array.isArray(groups)) return [];
    return groups.flatMap(group =>
        Array.isArray(group?.hooks)
            ? group.hooks.filter(h => h?.command === command).map(h => ({ group, h }))
            : []
    );
}

function isValidHookEventConfig(event, command, receiptCommands, matches) {
    if (!receiptCommands.includes(command) || matches.length !== 1) return false;
    const { group, h } = matches[0];
    if (h.type !== 'command' || h.async === true || h.timeout !== 10) return false;
    return event === 'PreToolUse' ? group.matcher === '.*' : group.matcher === undefined;
}

function resolveSkillsRoot(root, host, skillSource) {
    if (skillSource === 'plugin') {
        const subDir = host === 'claude' ? '.claude-plugin/skills' : 'procedures';
        return path.join(PACKAGE_ROOT, subDir);
    }
    const localDir = host === 'claude' ? '.claude/skills' : '.agents/skills';
    return safePath(root, localDir);
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function isValidReceipt(receipt, host) {
    return (
        receipt.version === 1 &&
        receipt.host === host &&
        Array.isArray(receipt.commands) &&
        typeof receipt.configHash === 'string' &&
        SHA256_RE.test(receipt.configHash)
    );
}

function inspectHost(root, host) {
    const configPath = hostConfigPath(host);
    const receiptPath = `.steward/install-${host}.json`;
    const result = { host, status: 'not-installed', nativeStatus: 'unchecked', problems: [] };
    if (!fs.existsSync(safePath(root, receiptPath))) {
        result.problems.push('No Steward installation receipt. Run install for this host.');
        return result;
    }
    result.status = 'broken';
    try {
        const receipt = readJSON(safePath(root, receiptPath));
        const config = readJSON(safePath(root, configPath));
        if (!isValidReceipt(receipt, host)) {
            result.problems.push('Invalid installation receipt. Review and reinstall this host.');
            return result;
        }
        for (const event of HOOK_EVENTS) {
            const command = hookCommand(root, host, event);
            const matches = findMatchingHooks(config?.hooks?.[event], command);
            if (!isValidHookEventConfig(event, command, receipt.commands, matches)) {
                result.problems.push(`${event}: missing, changed or duplicated handler. Reinstall from the current toolkit and Node path.`);
            }
        }
        if (config.disableAllHooks === true)
            result.problems.push('Hooks are disabled in this configuration.');
        const skillsRoot = resolveSkillsRoot(root, host, receipt.skillSource);
        for (const name of fs.readdirSync(path.join(PACKAGE_ROOT, 'procedures')).sort((a, b) => a.localeCompare(b, 'en'))) {
            if (!fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
                result.problems.push(`Missing skill: ${name}. Restore it through the matching installation mode.`);
        }
        if (!fs.existsSync(safePath(root, '.steward/USAGE.md')))
            result.problems.push('Missing local runner instructions. Rerun init or install.');
        if (!result.problems.length) result.status = 'configured';
    } catch {
        result.problems.push('Cannot read valid installation files. Inspect the host configuration and installation receipt.');
    }
    return result;
}

function selectDoctorHosts(root, host) {
    if (host) return [host];
    return fs.existsSync(safePath(root, '.steward/install-antigravity.json'))
        ? INSTALL_HOSTS
        : ['codex', 'claude'];
}

export function doctor(root, host = null, { allowUntrusted = false } = {}) {
    root = rootOf(root);
    insist(host === null || INSTALL_HOSTS.includes(host), 'BAD_HOST', 'Doctor supports codex, claude or antigravity.');
    let bundle = null;
    let trusted = true;
    let trustError = null;
    if (allowUntrusted) {
        try {
            bundle = requireTrust(root);
        } catch (err) {
            trusted = false;
            trustError = publicError(err);
            try {
                bundle = loadBundle(root);
            } catch {
                bundle = null;
            }
        }
    } else {
        bundle = requireTrust(root);
    }
    const rows = readJournal(root);
    const hosts = selectDoctorHosts(root, host).map(h => inspectHost(root, h));
    const installed = hosts.filter(h => h.status !== 'not-installed');
    const localHealthy = trusted && installed.length > 0 && installed.every(h => h.status === 'configured') &&
        (!host || hosts[0].status === 'configured');
    let nextMsg = 'Resolve the host installation findings, then rerun doctor.';
    if (!trusted) {
        nextMsg = trustError?.message || 'Review and approve this project policy and verification plan with steward trust.';
    } else if (localHealthy) {
        nextMsg = 'Start a native host session and verify hook invocation and skill discovery; local wiring is not live proof.';
    }
    return {
        healthy: false,
        localHealthy,
        trusted,
        ...(trustError ? { trustError } : {}),
        status: localHealthy ? 'unchecked' : 'needs-attention',
        bundleHash: bundle ? bundle.hash : null,
        journal: journalHead(rows),
        instructions: auditInstructions(root),
        hosts,
        liveHostVerified: false,
        next: nextMsg
    };
}
