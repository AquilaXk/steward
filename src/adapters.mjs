import path from 'node:path';
import { insist } from './errors.mjs';
import { isObject } from './schema.mjs';
import { normalizeTool, relativePath, validateEvent } from './engine.mjs';
import { rootOf } from './fs.mjs';
const events = {
    UserPromptSubmit: 'prompt',
    PreInvocation: 'prompt',
    PreToolUse: 'tool',
    SessionStart: 'session',
    PreCompact: 'compact'
};
export const HOSTS = ['generic', 'codex', 'claude', 'antigravity'];

function resolveHookCwd(root, rawCwd) {
    if (rawCwd === undefined) return root;
    insist(typeof rawCwd === 'string' && path.isAbsolute(rawCwd), 'BAD_CWD', 'Hook cwd must be absolute.');
    const cwd = rootOf(rawCwd);
    const rel = path.relative(root, cwd);
    insist(rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'BAD_CWD', 'Hook cwd is outside the selected project.');
    return cwd;
}

function populatePromptEvent(result, raw, host) {
    const p = raw.prompt, t = raw.prompt_text;
    if (p !== undefined && t !== undefined)
        insist(p === t, 'AMBIGUOUS_PROMPT', 'prompt and prompt_text disagree.');
    result.text = p ?? t ?? (host === 'antigravity' ? (raw.userPrompt ?? '') : undefined);
    insist(typeof result.text === 'string', 'BAD_INPUT', 'Prompt text is missing.');
}

function populatePatchEvent(result, ti, root, cwd) {
    const patch = ti.command ?? ti.patch;
    insist(typeof patch === 'string', 'BAD_PATCH', 'Patch text is missing.');
    const lines = patch.replaceAll('\r\n', '\n').trim().split('\n');
    insist(lines[0] === '*** Begin Patch' && lines.at(-1) === '*** End Patch', 'BAD_PATCH', 'Unsupported patch envelope.');
    for (const line of lines) {
        const m = /^\*\*\* (?:Add File|Update File|Delete File|Move from|Move to): (.+)$/.exec(line);
        if (m)
            result.paths.push(relativePath(root, m[1], cwd));
    }
    insist(result.paths.length > 0, 'BAD_PATCH', 'No recognized paths in patch.');
    result.text = patch;
}

function extractToolText(ti) {
    const editsText = Array.isArray(ti.edits)
        ? ti.edits.flatMap(e => [e?.old_string, e?.new_string])
        : [];
    return [
        ti.command,
        ti.CommandLine,
        ti.url,
        ti.Url,
        ti.description,
        ti.content,
        ti.CodeContent,
        ti.ReplacementContent,
        ti.TargetContent,
        ti.new_string,
        ti.old_string,
        ti.new_source,
        ...editsText
    ]
        .filter(v => typeof v === 'string' && v.length > 0)
        .join('\n');
}

function extractRawToolCall(raw) {
    if (isObject(raw.toolCall)) {
        return { toolName: raw.toolCall.name, toolInput: raw.toolCall.args };
    }
    return { toolName: raw.tool_name, toolInput: raw.tool_input };
}

function populateToolEvent(result, raw, root, cwd) {
    const { toolName, toolInput: ti } = extractRawToolCall(raw);
    insist(typeof toolName === 'string' && toolName, 'BAD_INPUT', 'tool_name is missing.');
    insist(isObject(ti), 'BAD_INPUT', 'tool_input must be an object.');
    result.tool = toolName;
    const kind = normalizeTool(result.tool);
    result.text = extractToolText(ti);
    if (kind === 'shell') {
        const cmd = ti.command ?? ti.CommandLine;
        insist(typeof cmd === 'string' && cmd.trim(), 'BAD_INPUT', 'Shell command is missing.');
    }
    if (result.tool.toLowerCase() === 'apply_patch') {
        populatePatchEvent(result, ti, root, cwd);
    }
    else if (kind === 'file.write' || kind === 'file.read') {
        const rawPath = ti.file_path ?? ti.notebook_path ?? ti.TargetFile ?? ti.AbsolutePath;
        insist(typeof rawPath === 'string' && rawPath, 'BAD_INPUT', 'File operation path is missing.');
        result.paths = [relativePath(root, rawPath, cwd)];
        result.text = [rawPath, result.text].filter(Boolean).join('\n');
    }
    result.paths = [...new Set(result.paths)];
}

function resolveRawEventName(host, raw, expectedEvent) {
    if (expectedEvent && raw.hook_event_name !== undefined) {
        insist(raw.hook_event_name === expectedEvent, 'EVENT_MISMATCH', 'Hook event does not match the registered handler.');
    }
    return raw.hook_event_name ?? (host === 'antigravity' ? expectedEvent : undefined);
}

export function normalizeInput(host, raw, root, expectedEvent = null) {
    root = rootOf(root);
    insist(HOSTS.includes(host), 'BAD_HOST', 'Host must be generic, codex, claude or antigravity.');
    if (host === 'generic') {
        validateEvent(raw);
        return validateEvent({ ...raw, paths: [...new Set(raw.paths.map(p => relativePath(root, p)))] });
    }
    insist(isObject(raw), 'BAD_INPUT', 'Hook input must be an object.');
    const rawEventName = resolveRawEventName(host, raw, expectedEvent);
    const event = typeof rawEventName === 'string' && Object.hasOwn(events, rawEventName) ? events[rawEventName] : null;
    insist(event, 'BAD_EVENT', 'Unsupported host event.');
    const cwd = resolveHookCwd(root, raw.cwd ?? raw.toolCall?.args?.Cwd);
    const result = { event, text: '', tool: null, paths: [], sessionId: raw.session_id ?? raw.conversationId ?? null };
    if (event === 'prompt') populatePromptEvent(result, raw, host);
    if (event === 'tool') populateToolEvent(result, raw, root, cwd);
    return validateEvent(result);
}

function encodeAntigravityResponse(event, result) {
    if (result.decision === 'deny') {
        if (event === 'tool') {
            return { stdout: JSON.stringify({ decision: 'deny', reason: result.reason }), stderr: '', exitCode: 0 };
        }
        return {
            stdout: JSON.stringify({ injectSteps: [{ ephemeralMessage: result.reason }] }),
            stderr: result.reason,
            exitCode: 0
        };
    }
    if (event === 'tool') {
        return { stdout: JSON.stringify({ decision: 'allow' }), stderr: '', exitCode: 0 };
    }
    if ((event === 'session' || event === 'prompt') && result.context) {
        return {
            stdout: JSON.stringify({ injectSteps: [{ ephemeralMessage: result.context }] }),
            stderr: '',
            exitCode: 0
        };
    }
    return { stdout: '{}', stderr: '', exitCode: 0 };
}

function encodeDenyResponse(host, event, reason) {
    if (event === 'tool')
        return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), stderr: '', exitCode: 0 };
    if (event === 'compact') {
        if (host === 'codex') return { stdout: JSON.stringify({ continue: false, stopReason: reason }), stderr: '', exitCode: 0 };
        return { stdout: JSON.stringify({ decision: 'block', reason }), stderr: reason, exitCode: 2 };
    }
    if (event === 'session' && host === 'codex') {
        return { stdout: JSON.stringify({ continue: false, stopReason: reason }), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: reason, exitCode: 2 };
}

export function encode(host, event, result) {
    if (host === 'generic')
        return { stdout: JSON.stringify(result), stderr: '', exitCode: result.decision === 'deny' ? 2 : 0 };
    if (host === 'antigravity')
        return encodeAntigravityResponse(event, result);
    if (result.decision === 'deny')
        return encodeDenyResponse(host, event, result.reason);
    if (event === 'compact' || !result.context)
        return { stdout: '{}', stderr: '', exitCode: 0 };
    const hookEventName = { tool: 'PreToolUse', prompt: 'UserPromptSubmit', session: 'SessionStart' }[event];
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } }), stderr: '', exitCode: 0 };
}
export const eventKind = (hostEvent) => (typeof hostEvent === 'string' && Object.hasOwn(events, hostEvent) ? events[hostEvent] : 'prompt');
