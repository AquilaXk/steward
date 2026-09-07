import * as fs from 'node:fs';
import path from 'node:path';
import { safePath, readJSON } from './fs.mjs';
import { insist } from './errors.mjs';
import { requireTrust } from './trust.mjs';
import { readJournal, journalHead } from './journal.mjs';
import { auditInstructions } from './instructions.mjs';
import { HOOK_EVENTS, hookCommand, PACKAGE_ROOT } from './setup.mjs';

function inspectHost(root, host) {
    const configPath = host === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json';
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
        if (receipt.version !== 1 || receipt.host !== host || !Array.isArray(receipt.commands)) {
            result.problems.push('Invalid installation receipt. Review and reinstall this host.');
            return result;
        }
        for (const event of HOOK_EVENTS) {
            const command = hookCommand(root, host, event);
            const groups = config?.hooks?.[event];
            const matches = Array.isArray(groups) ? groups.flatMap(group =>
                Array.isArray(group?.hooks) ? group.hooks.filter(h => h?.command === command).map(h => ({ group, h })) : []) : [];
            if (!receipt.commands.includes(command) || matches.length !== 1 ||
                matches[0].h.type !== 'command' || matches[0].h.async === true ||
                matches[0].h.timeout !== 10 ||
                (event === 'PreToolUse' ? matches[0].group.matcher !== '.*' : matches[0].group.matcher !== undefined)) {
                result.problems.push(`${event}: missing, changed or duplicated handler. Reinstall from the current toolkit and Node path.`);
            }
        }
        if (config.disableAllHooks === true)
            result.problems.push('Hooks are disabled in this configuration.');
        const skillsRoot = receipt.skillSource === 'plugin' ? path.join(PACKAGE_ROOT, host === 'claude' ? '.claude-plugin/skills' : 'procedures') :
            safePath(root, host === 'codex' ? '.agents/skills' : '.claude/skills');
        for (const name of fs.readdirSync(path.join(PACKAGE_ROOT, 'procedures'))) {
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

export function doctor(root, host = null) {
    insist(host === null || ['codex', 'claude'].includes(host), 'BAD_HOST', 'Doctor supports codex or claude.');
    const bundle = requireTrust(root);
    const rows = readJournal(root);
    const hosts = (host ? [host] : ['codex', 'claude']).map(h => inspectHost(root, h));
    const installed = hosts.filter(h => h.status !== 'not-installed');
    const localHealthy = installed.length > 0 && installed.every(h => h.status === 'configured') &&
        (!host || hosts[0].status === 'configured');
    return { healthy: false, localHealthy, status: localHealthy ? 'unchecked' : 'needs-attention',
        bundleHash: bundle.hash, journal: journalHead(rows), instructions: auditInstructions(root), hosts,
        liveHostVerified: false, next: localHealthy ?
            'Start a native host session and verify hook invocation and skill discovery; local wiring is not live proof.' :
            'Resolve the host installation findings, then rerun doctor.' };
}
