import * as fs from 'node:fs';
import path from 'node:path';
import { insist } from './errors.mjs';
import { isObject } from './schema.mjs';
import { normalizeTool, relativePath, validateEvent } from './engine.mjs';
import { rootOf, canonical } from './fs.mjs';
const events = {
    UserPromptSubmit: 'prompt',
    PreInvocation: 'prompt',
    PreToolUse: 'tool',
    SessionStart: 'session',
    PreCompact: 'compact',
    Stop: 'stop'
};
export const HOSTS = ['generic', 'codex', 'claude', 'antigravity'];
const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const OPEN_USER_REQ = '<USER_REQUEST>';
const CLOSE_USER_REQ = '</USER_REQUEST>';

function unwrapUserRequest(content) {
    const start = content.indexOf(OPEN_USER_REQ);
    if (start < 0) return content;
    const bodyStart = start + OPEN_USER_REQ.length;
    const end = content.indexOf(CLOSE_USER_REQ, bodyStart);
    return end < 0 ? content : content.slice(bodyStart, end).trim();
}

function parseTranscriptLinePrompt(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const entry = JSON.parse(trimmed);
        return entry?.type === 'USER_INPUT' && typeof entry.content === 'string'
            ? unwrapUserRequest(entry.content)
            : null;
    } catch {
        return null;
    }
}

function readTranscriptTail(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath || transcriptPath.includes('\0') || !path.isAbsolute(transcriptPath)) {
        return '';
    }
    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r'); //NOSONAR
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size === 0) return '';
        const length = Math.min(stat.size, MAX_TRANSCRIPT_TAIL_BYTES);
        const buf = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, stat.size - length);
        return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore close error */ }
        }
    }
}

function extractAntigravityTranscriptPrompt(transcriptPath) {
    const tail = readTranscriptTail(transcriptPath);
    if (!tail) return '';
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const prompt = parseTranscriptLinePrompt(lines[i]);
        if (prompt !== null) return prompt;
    }
    return '';
}

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
    result.text = p ?? t ?? (host === 'antigravity' ? (raw.userPrompt ?? extractAntigravityTranscriptPrompt(raw.transcriptPath)) : undefined);
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
    const chunksText = Array.isArray(ti.ReplacementChunks)
        ? ti.ReplacementChunks.flatMap(c => [c?.TargetContent, c?.ReplacementContent])
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
        ...editsText,
        ...chunksText
    ]
        .filter(v => typeof v === 'string' && v.length > 0)
        .join('\n');
}

function resolveToolCallInput(toolCall) {
    const a = toolCall.args, b = toolCall.arguments;
    if (a !== undefined && b !== undefined) {
        insist(isObject(a) && isObject(b) && canonical(a) === canonical(b), 'BAD_INPUT', 'toolCall.args and toolCall.arguments disagree.');
    }
    return a ?? b;
}

function extractRawToolCall(raw) {
    if (isObject(raw.toolCall)) {
        return { toolName: raw.toolCall.name, toolInput: resolveToolCallInput(raw.toolCall) };
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

export function inferAntigravityEvent(raw) {
    if (!isObject(raw)) return undefined;
    if (isObject(raw.toolCall)) return 'PreToolUse';
    if (raw.invocationNum !== undefined || raw.userPrompt !== undefined) return 'PreInvocation';
    if (raw.terminationReason !== undefined) return 'Stop';
    if (typeof raw.conversationId === 'string') return 'SessionStart';
    return undefined;
}

function resolveRawEventName(host, raw, expectedEvent) {
    if (expectedEvent && raw.hook_event_name !== undefined) {
        insist(raw.hook_event_name === expectedEvent, 'EVENT_MISMATCH', 'Hook event does not match the registered handler.');
    }
    if (raw.hook_event_name !== undefined) return raw.hook_event_name;
    if (host === 'antigravity') return expectedEvent ?? inferAntigravityEvent(raw);
    return undefined;
}

function populateEventDetails(result, raw, host, root, cwd) {
    if (result.event === 'prompt') populatePromptEvent(result, raw, host);
    else if (result.event === 'tool') populateToolEvent(result, raw, root, cwd);
    else if (result.event === 'stop' && typeof raw.terminationReason === 'string') result.text = raw.terminationReason;
}

function extractHookCwd(raw) {
    if (raw.cwd !== undefined) return raw.cwd;
    if (isObject(raw.toolCall)) {
        const ti = resolveToolCallInput(raw.toolCall);
        return isObject(ti) ? ti.Cwd : undefined;
    }
    return undefined;
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
    const cwd = resolveHookCwd(root, extractHookCwd(raw));
    const result = { event, text: '', tool: null, paths: [], sessionId: raw.session_id ?? raw.conversationId ?? null };
    populateEventDetails(result, raw, host, root, cwd);
    return validateEvent(result);
}

function encodeAntigravityResponse(event, result) {
    if (event === 'stop' && !result.error) {
        const payload = result.decision === 'deny'
            ? { decision: 'continue', reason: result.reason }
            : { decision: 'allow' };
        return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 };
    }
    if (result.decision === 'deny') {
        if (event === 'tool') {
            return { stdout: JSON.stringify({ decision: 'deny', reason: result.reason }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: result.reason, exitCode: 2 };
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
