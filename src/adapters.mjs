import path from 'node:path';
import { insist } from './errors.mjs';
import { isObject } from './schema.mjs';
import { normalizeTool, relativePath, validateEvent } from './engine.mjs';
import { rootOf } from './fs.mjs';
const events = { UserPromptSubmit: 'prompt', PreToolUse: 'tool', SessionStart: 'session', PreCompact: 'compact' };
export const HOSTS = ['generic', 'codex', 'claude'];
export function normalizeInput(host, raw, root, expectedEvent = null) {
    root = rootOf(root);
    insist(HOSTS.includes(host), 'BAD_HOST', 'Host must be generic, codex or claude.');
    if (host === 'generic') {
        validateEvent(raw);
        return validateEvent({ ...raw, paths: [...new Set(raw.paths.map(p => relativePath(root, p)))] });
    }
    insist(isObject(raw), 'BAD_INPUT', 'Hook input must be an object.');
    if (expectedEvent)
        insist(raw.hook_event_name === expectedEvent, 'EVENT_MISMATCH', 'Hook event does not match the registered handler.');
    const event = events[raw.hook_event_name];
    insist(event, 'BAD_EVENT', 'Unsupported host event.');
    let cwd = root;
    if (raw.cwd !== undefined) {
        insist(typeof raw.cwd === 'string' && path.isAbsolute(raw.cwd), 'BAD_CWD', 'Hook cwd must be absolute.');
        cwd = rootOf(raw.cwd);
        const rel = path.relative(root, cwd);
        insist(rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'BAD_CWD', 'Hook cwd is outside the selected project.');
    }
    const result = { event, text: '', tool: null, paths: [], sessionId: raw.session_id ?? null };
    if (event === 'prompt') {
        const p = raw.prompt, t = raw.prompt_text;
        if (p !== undefined && t !== undefined)
            insist(p === t, 'AMBIGUOUS_PROMPT', 'prompt and prompt_text disagree.');
        result.text = p ?? t;
        insist(typeof result.text === 'string', 'BAD_INPUT', 'Prompt text is missing.');
    }
    if (event === 'tool') {
        insist(typeof raw.tool_name === 'string' && raw.tool_name, 'BAD_INPUT', 'tool_name is missing.');
        const ti = raw.tool_input;
        insist(isObject(ti), 'BAD_INPUT', 'tool_input must be an object.');
        result.tool = raw.tool_name;
        const kind = normalizeTool(result.tool);
        result.text = [ti.command, ti.url, ti.description].filter(v => typeof v === 'string').join('\n');
        if (kind === 'shell')
            insist(typeof ti.command === 'string' && ti.command.trim(), 'BAD_INPUT', 'Shell command is missing.');
        if (result.tool.toLowerCase() === 'apply_patch') {
            const patch = ti.command ?? ti.patch;
            insist(typeof patch === 'string', 'BAD_PATCH', 'Patch text is missing.');
            const lines = patch.replaceAll('\r\n', '\n').trim().split('\n');
            insist(lines[0] === '*** Begin Patch' && lines.at(-1) === '*** End Patch', 'BAD_PATCH', 'Unsupported patch envelope.');
            for (const line of lines) {
                const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
                if (m)
                    result.paths.push(relativePath(root, m[1], cwd));
            }
            insist(result.paths.length > 0, 'BAD_PATCH', 'No recognized paths in patch.');
            result.text = patch;
        }
        else if (kind === 'file.write' || kind === 'file.read') {
            insist(typeof ti.file_path === 'string' && ti.file_path, 'BAD_INPUT', 'File operation path is missing.');
            result.paths = [relativePath(root, ti.file_path, cwd)];
            result.text = ti.file_path;
        }
        result.paths = [...new Set(result.paths)];
    }
    return validateEvent(result);
}
export function encode(host, event, result) {
    if (host === 'generic')
        return { stdout: JSON.stringify(result), stderr: '', exitCode: result.decision === 'deny' ? 2 : 0 };
    if (result.decision === 'deny') {
        if (event === 'tool')
            return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }), stderr: '', exitCode: 0 };
        if (event === 'compact')
            return host === 'codex'
                ? { stdout: JSON.stringify({ continue: false, stopReason: result.reason }), stderr: '', exitCode: 0 }
                : { stdout: JSON.stringify({ decision: 'block', reason: result.reason }), stderr: result.reason, exitCode: 2 };
        if (event === 'session')
            return host === 'codex'
                ? { stdout: JSON.stringify({ continue: false, stopReason: result.reason }), stderr: '', exitCode: 0 }
                : { stdout: '', stderr: result.reason, exitCode: 2 }; // Claude SessionStart reports errors but cannot block startup.
        return { stdout: '', stderr: result.reason, exitCode: 2 };
    }
    if (event === 'compact')
        return { stdout: '{}', stderr: '', exitCode: 0 }; // Persistence has already completed. No unsupported context injection.
    if (!result.context)
        return { stdout: '{}', stderr: '', exitCode: 0 };
    const hookEventName = { tool: 'PreToolUse', prompt: 'UserPromptSubmit', session: 'SessionStart' }[event];
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } }), stderr: '', exitCode: 0 };
}
export const eventKind = (hostEvent) => events[hostEvent] || 'prompt';
