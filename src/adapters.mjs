// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import path from 'node:path';
import { insist, StewardError } from './errors.mjs';
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

const MAX_TRANSCRIPT_LINE_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const OVERSIZED_SNIPPET_BYTES = 4096;
const OPEN_USER_REQ = '<USER_REQUEST>';
const CLOSE_USER_REQ = '</USER_REQUEST>';

function unwrapUserRequest(content) {
    const start = content.indexOf(OPEN_USER_REQ);
    if (start < 0) return content;
    const bodyStart = start + OPEN_USER_REQ.length;
    const end = content.lastIndexOf(CLOSE_USER_REQ);
    return end < bodyStart ? content : content.slice(bodyStart, end).trim();
}

function parseTranscriptLinePrompt(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{')) {
        insist(!trimmed.includes('USER_INPUT') && !trimmed.includes('\\u'), 'BAD_EVENT', 'Malformed USER_INPUT transcript record.');
        return null;
    }
    if (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('\\u')) return null;
    let entry;
    try {
        entry = JSON.parse(trimmed);
    } catch {
        if (!hasTopLevelNonUserType(trimmed)) {
            throw new StewardError('BAD_EVENT', 'Malformed USER_INPUT transcript record.');
        }
        return null;
    }
    if (entry?.type !== 'USER_INPUT') return null;
    insist(typeof entry.content === 'string', 'BAD_EVENT', 'Malformed USER_INPUT transcript record.');
    return unwrapUserRequest(entry.content);
}

const USER_INPUT_BOUNDARY_BYTES = 16;

function skipJsonWhitespace(str, idx) {
    while (idx < str.length) {
        const ch = str.charCodeAt(idx);
        if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) break;
        idx++;
    }
    return idx;
}

function readJsonStringEnd(str, startQuoteIdx) {
    for (let i = startQuoteIdx + 1; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        if (ch === 0x5c) {
            i++;
            continue;
        }
        if (ch === 0x22) {
            return i;
        }
    }
    return -1;
}

function hasTopLevelNonUserType(headText) {
    let i = skipJsonWhitespace(headText, 0);
    if (i >= headText.length || headText.charCodeAt(i) !== 0x7b) return false;
    i++;
    let depth = 1;
    let state = 'KEY_OR_END';
    let lastKey = null;

    while (i < headText.length) {
        if (depth > 1) {
            const ch = headText.charCodeAt(i);
            if (ch === 0x22) {
                const end = readJsonStringEnd(headText, i);
                if (end === -1) return false;
                i = end + 1;
                continue;
            }
            if (ch === 0x7b || ch === 0x5b) depth++;
            else if (ch === 0x7d || ch === 0x5d) {
                depth--;
                if (depth === 1) state = 'COMMA_OR_END';
            }
            i++;
            continue;
        }

        i = skipJsonWhitespace(headText, i);
        if (i >= headText.length) return false;
        const ch = headText.charCodeAt(i);

        if (state === 'KEY_OR_END') {
            if (ch === 0x7d) return false;
            if (ch !== 0x22) return false;
            const end = readJsonStringEnd(headText, i);
            if (end === -1) return false;
            try {
                lastKey = JSON.parse(headText.slice(i, end + 1));
            } catch {
                return false;
            }
            i = end + 1;
            state = 'COLON';
        } else if (state === 'COLON') {
            if (ch !== 0x3a) return false;
            i++;
            state = 'VALUE';
        } else if (state === 'VALUE') {
            if (ch === 0x22) {
                const end = readJsonStringEnd(headText, i);
                if (end === -1) return false;
                if (lastKey === 'type') {
                    try {
                        const typeVal = JSON.parse(headText.slice(i, end + 1));
                        return typeof typeVal === 'string' && typeVal !== 'USER_INPUT';
                    } catch {
                        return false;
                    }
                }
                i = end + 1;
                state = 'COMMA_OR_END';
            } else if (ch === 0x7b || ch === 0x5b) {
                depth++;
                i++;
            } else {
                if (lastKey === 'type') return false;
                while (i < headText.length) {
                    const c = headText.charCodeAt(i);
                    if (c === 0x2c || c === 0x7d || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
                    i++;
                }
                state = 'COMMA_OR_END';
            }
        } else if (state === 'COMMA_OR_END') {
            if (ch === 0x2c) {
                i++;
                state = 'KEY_OR_END';
            } else {
                return false;
            }
        }
    }
    return false;
}

function isOversizedUserInputOrUnknown(headText, sawUserInputToken) {
    if (sawUserInputToken) return true;
    return !hasTopLevelNonUserType(headText);
}

function createBackwardLineCollector() {
    return {
        parts: [],
        bytes: 0,
        oversized: false,
        sawUserInputToken: false,
        prevLeftPrefix: Buffer.alloc(0),
        leftHead: Buffer.alloc(0)
    };
}

function prependChunkSliceToLine(collector, slice) {
    if (slice.length === 0) return;
    if (!collector.sawUserInputToken) {
        if (slice.includes('USER_INPUT')) {
            collector.sawUserInputToken = true;
        } else if (collector.prevLeftPrefix.length > 0) {
            const rightTail = slice.length > USER_INPUT_BOUNDARY_BYTES
                ? slice.subarray(slice.length - USER_INPUT_BOUNDARY_BYTES)
                : slice;
            if (Buffer.concat([rightTail, collector.prevLeftPrefix]).includes('USER_INPUT')) {
                collector.sawUserInputToken = true;
            }
        }
    }
    collector.prevLeftPrefix = slice.length >= USER_INPUT_BOUNDARY_BYTES
        ? slice.subarray(0, USER_INPUT_BOUNDARY_BYTES)
        : Buffer.concat([slice, collector.prevLeftPrefix]).subarray(0, USER_INPUT_BOUNDARY_BYTES);

    if (!collector.oversized) {
        if (collector.bytes + slice.length <= MAX_TRANSCRIPT_LINE_BYTES) {
            collector.parts.push(slice);
            collector.bytes += slice.length;
            return;
        }
        const tailConcat = Buffer.concat([slice, ...collector.parts.slice().reverse()]);
        collector.leftHead = tailConcat.subarray(0, Math.min(tailConcat.length, OVERSIZED_SNIPPET_BYTES));
        collector.parts = [];
        collector.bytes += slice.length;
        collector.oversized = true;
        return;
    }
    collector.bytes += slice.length;
    if (slice.length >= OVERSIZED_SNIPPET_BYTES) {
        collector.leftHead = slice.subarray(0, OVERSIZED_SNIPPET_BYTES);
    } else {
        const combined = Buffer.concat([slice, collector.leftHead]);
        collector.leftHead = combined.subarray(0, OVERSIZED_SNIPPET_BYTES);
    }
}

function finalizeBackwardLine(collector) {
    if (collector.bytes === 0) return null;
    if (collector.oversized) {
        const headText = collector.leftHead.toString('utf8');
        insist(!isOversizedUserInputOrUnknown(headText, collector.sawUserInputToken), 'BAD_EVENT', 'Invalid or oversized event text.');
        return null;
    }
    const lineBuf = collector.parts.length === 1
        ? collector.parts[0]
        : Buffer.concat(collector.parts.reverse());
    const text = lineBuf.toString('utf8');
    return parseTranscriptLinePrompt(text);
}

function extractAntigravityTranscriptPrompt(transcriptPath) {
    if (transcriptPath === undefined) return '';
    insist(typeof transcriptPath === 'string' && transcriptPath && !transcriptPath.includes('\0') && path.isAbsolute(transcriptPath), 'BAD_INPUT', 'Invalid transcriptPath.');
    let lstat;
    try {
        lstat = fs.lstatSync(transcriptPath); //NOSONAR
    } catch (e) {
        if (e?.code === 'ENOENT') return '';
        throw e;
    }
    insist(lstat.isFile() && !lstat.isSymbolicLink(), 'BAD_INPUT', 'Transcript must be a regular, non-symlink file.');
    if (lstat.size === 0) return '';

    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r'); //NOSONAR
        let pos = lstat.size;
        let scanned = 0;
        let sawNewline = false;
        let collector = createBackwardLineCollector();

        while (pos > 0 && scanned < MAX_TRANSCRIPT_SCAN_BYTES) {
            const remainingBudget = MAX_TRANSCRIPT_SCAN_BYTES - scanned;
            const toRead = Math.min(pos, TRANSCRIPT_CHUNK_BYTES, remainingBudget);
            const buf = Buffer.allocUnsafe(toRead);
            const bytesRead = fs.readSync(fd, buf, 0, toRead, pos - toRead);
            if (bytesRead <= 0) break;

            pos -= bytesRead;
            scanned += bytesRead;

            let cursor = bytesRead;
            while (cursor > 0) {
                const nlIdx = buf.lastIndexOf(0x0a, cursor - 1);
                if (nlIdx === -1) {
                    prependChunkSliceToLine(collector, Buffer.from(buf.subarray(0, cursor)));
                    break;
                }
                sawNewline = true;
                prependChunkSliceToLine(collector, Buffer.from(buf.subarray(nlIdx + 1, cursor)));
                const prompt = finalizeBackwardLine(collector);
                if (prompt !== null) return prompt;
                collector = createBackwardLineCollector();
                cursor = nlIdx;
            }
        }

        if (lstat.size > MAX_TRANSCRIPT_SCAN_BYTES && !sawNewline) {
            insist(false, 'BAD_EVENT', 'Invalid or oversized event text.');
        }

        if (pos === 0 && collector.bytes > 0) {
            const prompt = finalizeBackwardLine(collector);
            if (prompt !== null) return prompt;
        } else if (collector.oversized) {
            const headText = collector.leftHead.toString('utf8');
            insist(!isOversizedUserInputOrUnknown(headText, collector.sawUserInputToken), 'BAD_EVENT', 'Invalid or oversized event text.');
        }

        return '';
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
    }
}

const MAX_SYMLINK_HOPS = 40;

function resolveRealTargetPath(candidate) {
    const trailing = [];
    let cur = candidate;
    let hops = 0;
    while (true) {
        try {
            const real = fs.realpathSync(cur); //NOSONAR
            return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
        } catch (err) {
            if (err?.code === 'ELOOP') {
                throw new StewardError('SYMLINK', 'Symbolic link loop detected while resolving event path.');
            }
            if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
                throw err;
            }
            let st = null;
            try {
                st = fs.lstatSync(cur);
            } catch (lstatErr) {
                if (lstatErr?.code !== 'ENOENT' && lstatErr?.code !== 'ENOTDIR') {
                    throw lstatErr;
                }
            }
            if (st !== null && st.isSymbolicLink()) {
                if (++hops > MAX_SYMLINK_HOPS) {
                    throw new StewardError('SYMLINK', 'Symbolic link loop detected while resolving event path.');
                }
                const nextBase = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
                cur = trailing.length === 0 ? nextBase : path.join(nextBase, ...trailing.reverse());
                trailing.length = 0;
                continue;
            }
            const parent = path.dirname(cur);
            if (parent === cur) return candidate;
            trailing.push(path.basename(cur));
            cur = parent;
        }
    }
}

const MAX_PATH_WALK_STEPS = 4096;

function pushReversedSegments(stack, relPath) {
    if (!relPath) return;
    const parts = relPath.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]) stack.push(parts[i]);
    }
}

function resolveAdapterRelativePath(root, rawInput, cwd = root) {
    insist(typeof rawInput === 'string' && !rawInput.includes('\0'), 'BAD_PATH', 'Path must not contain null bytes.');
    const cleaned = rawInput.replaceAll('\\', '/');
    if (process.platform !== 'win32' && /^[a-z]:\//i.test(cleaned)) {
        return '@outside/' + cleaned;
    }

    let cur;
    let initialRest;
    if (cleaned.startsWith('/')) {
        if (process.platform === 'win32' && cleaned.startsWith('//')) {
            const parsedRoot = path.parse(cleaned.replaceAll('/', path.sep)).root;
            cur = parsedRoot;
            initialRest = cleaned.slice(parsedRoot.length);
        } else {
            cur = process.platform === 'win32' ? path.parse(resolveRealTargetPath(cwd)).root : '/';
            initialRest = cleaned.slice(1);
        }
    } else if (process.platform === 'win32' && /^[a-z]:/i.test(cleaned)) {
        cur = cleaned.slice(0, 2).toUpperCase() + '\\';
        initialRest = cleaned.slice(2).replace(/^\/+/, '');
    } else {
        cur = resolveRealTargetPath(cwd);
        initialRest = cleaned;
    }

    const stack = [];
    pushReversedSegments(stack, initialRest);
    let hops = 0;
    let steps = 0;

    while (stack.length > 0) {
        if (++steps > MAX_PATH_WALK_STEPS) {
            throw new StewardError('BAD_PATH', 'Path traversal depth exceeded.');
        }
        const seg = stack.pop();
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            cur = path.dirname(cur);
            continue;
        }
        const next = path.join(cur, seg);
        let st = null;
        try {
            st = fs.lstatSync(next); //NOSONAR
        } catch (err) {
            if (err?.code === 'ELOOP') {
                throw new StewardError('SYMLINK', 'Symbolic link loop detected while resolving event path.');
            }
            if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
                throw err;
            }
        }
        if (st !== null && st.isSymbolicLink()) {
            if (++hops > MAX_SYMLINK_HOPS) {
                throw new StewardError('SYMLINK', 'Symbolic link loop detected while resolving event path.');
            }
            const rawTarget = fs.readlinkSync(next).replaceAll('\\', '/'); //NOSONAR
            if (rawTarget.startsWith('/')) {
                if (process.platform === 'win32' && rawTarget.startsWith('//')) {
                    const parsedRoot = path.parse(rawTarget.replaceAll('/', path.sep)).root;
                    cur = parsedRoot;
                    pushReversedSegments(stack, rawTarget.slice(parsedRoot.length));
                } else {
                    cur = process.platform === 'win32' ? path.parse(next).root : '/';
                    pushReversedSegments(stack, rawTarget.slice(1));
                }
            } else if (process.platform === 'win32' && /^[a-z]:/i.test(rawTarget)) {
                cur = rawTarget.slice(0, 2).toUpperCase() + '\\';
                pushReversedSegments(stack, rawTarget.slice(2).replace(/^\/+/, ''));
            } else {
                pushReversedSegments(stack, rawTarget);
            }
            continue;
        }
        cur = next;
    }

    return relativePath(root, cur, cwd);
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
    const inlinePrompts = [raw.prompt, raw.prompt_text, ...(host === 'antigravity' ? [raw.userPrompt] : [])].filter(v => v !== undefined);
    insist(new Set(inlinePrompts).size <= 1, 'AMBIGUOUS_PROMPT', 'prompt and prompt_text disagree.');
    result.text = inlinePrompts[0] ?? (host === 'antigravity' ? extractAntigravityTranscriptPrompt(raw.transcriptPath) : undefined);
    insist(typeof result.text === 'string', 'BAD_INPUT', 'Prompt text is missing.');
}

function populatePatchEvent(result, ti, root, cwd) {
    if (ti.command !== undefined && ti.patch !== undefined) {
        insist(ti.command === ti.patch, 'BAD_PATCH', 'Patch fields disagree.');
    }
    const patch = ti.command ?? ti.patch;
    insist(typeof patch === 'string', 'BAD_PATCH', 'Patch text is missing.');
    const lines = patch.replaceAll('\r\n', '\n').trim().split('\n');
    insist(lines[0] === '*** Begin Patch' && lines.at(-1) === '*** End Patch', 'BAD_PATCH', 'Unsupported patch envelope.');
    for (const line of lines) {
        const m = /^\*\*\* (?:Add File|Update File|Delete File|Move from|Move to): (.+)$/.exec(line);
        if (m)
            result.paths.push(resolveAdapterRelativePath(root, m[1].trim(), cwd));
    }
    insist(result.paths.length > 0, 'BAD_PATCH', 'No recognized paths in patch.');
    result.text = patch;
}

const MCP_PATH_KEYS = new Set(['Path', 'path', 'file_path', 'notebook_path', 'TargetFile', 'AbsolutePath', 'source', 'destination']);
const MAX_MCP_EXTRACT_DEPTH = 8;

function collectMcpArguments(value, root, cwd, outTexts, outPaths, depth = 0) {
    if (value === null || value === undefined) return;
    insist(depth <= MAX_MCP_EXTRACT_DEPTH, 'BAD_INPUT', 'MCP tool arguments exceed maximum nesting depth.');
    if (typeof value === 'string') {
        if (value.length > 0) outTexts.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            collectMcpArguments(value[i], root, cwd, outTexts, outPaths, depth + 1);
        }
        return;
    }
    if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'string' && v.length > 0 && MCP_PATH_KEYS.has(k)) {
                outPaths.push(resolveAdapterRelativePath(root, v, cwd));
            }
            collectMcpArguments(v, root, cwd, outTexts, outPaths, depth + 1);
        }
    }
}

function extractToolText(ti, kind) {
    if (kind === 'shell') {
        return [ti.command, ti.CommandLine, ti.cmd]
            .filter(v => typeof v === 'string' && v.length > 0)
            .join('\n');
    }
    const editsText = Array.isArray(ti.edits)
        ? ti.edits.flatMap(e => [e?.old_string, e?.new_string])
        : [];
    const chunksText = Array.isArray(ti.ReplacementChunks)
        ? ti.ReplacementChunks.flatMap(c => [c?.TargetContent, c?.ReplacementContent])
        : [];
    return [
        ti.command,
        ti.CommandLine,
        ti.cmd,
        ti.url,
        ti.Url,
        ti.description,
        ti.content,
        ti.Content,
        ti.Target,
        ti.Replacement,
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

function resolveOptionalSingleStringField(values, invalidMessage, conflictMessage) {
    const defined = values.filter(v => v !== undefined);
    if (defined.length === 0) return undefined;
    insist(defined.every(v => typeof v === 'string' && v.length > 0), 'BAD_INPUT', invalidMessage);
    insist(new Set(defined).size === 1, 'BAD_INPUT', conflictMessage);
    return defined[0];
}

function resolveSingleStringField(values, missingMessage, conflictMessage, requireTrimmed = false) {
    const defined = values.filter(v => v !== undefined);
    insist(
        defined.length > 0 && defined.every(v => typeof v === 'string' && (requireTrimmed ? v.trim().length > 0 : v.length > 0)),
        'BAD_INPUT',
        missingMessage
    );
    insist(new Set(defined).size === 1, 'BAD_INPUT', conflictMessage);
    return defined[0];
}

function populateToolEvent(result, raw, root, cwd) {
    const { toolName, toolInput: ti } = extractRawToolCall(raw);
    insist(typeof toolName === 'string' && toolName, 'BAD_INPUT', 'tool_name is missing.');
    insist(isObject(ti), 'BAD_INPUT', 'tool_input must be an object.');
    result.tool = toolName;
    const kind = normalizeTool(result.tool);
    result.text = extractToolText(ti, kind);
    if (kind === 'shell') {
        resolveSingleStringField(
            [ti.command, ti.CommandLine, ti.cmd],
            'Shell command is missing.',
            'Shell command fields disagree.',
            true
        );
    }
    if (result.tool.toLowerCase() === 'call_mcp_tool') {
        const mcpTexts = [];
        const serverName = resolveOptionalSingleStringField(
            [ti.ServerName, ti.server_name, ti.serverName],
            'MCP ServerName must be a non-empty string.',
            'MCP ServerName fields disagree.'
        );
        const mcpToolName = resolveOptionalSingleStringField(
            [ti.ToolName, ti.tool_name, ti.toolName],
            'MCP ToolName must be a non-empty string.',
            'MCP ToolName fields disagree.'
        );
        if (serverName !== undefined) mcpTexts.push(serverName);
        if (mcpToolName !== undefined) mcpTexts.push(mcpToolName);
        if (ti.Arguments !== undefined && ti.arguments !== undefined) {
            insist(
                isObject(ti.Arguments) && isObject(ti.arguments) && canonical(ti.Arguments) === canonical(ti.arguments),
                'BAD_INPUT',
                'MCP tool Arguments and arguments disagree.'
            );
        }
        const mcpArgs = ti.Arguments ?? ti.arguments;
        if (mcpArgs !== undefined) {
            insist(isObject(mcpArgs), 'BAD_INPUT', 'MCP tool arguments must be an object.');
            collectMcpArguments(mcpArgs, root, cwd, mcpTexts, result.paths);
        }
        if (mcpTexts.length > 0) {
            result.text = [...mcpTexts, result.text].filter(Boolean).join('\n');
        }
    }
    if (result.tool.toLowerCase() === 'apply_patch') {
        populatePatchEvent(result, ti, root, cwd);
    }
    else if (kind === 'file.write' || kind === 'file.read') {
        const rawPath = resolveSingleStringField(
            [ti.file_path, ti.notebook_path, ti.TargetFile, ti.AbsolutePath, ti.Path, ti.path],
            'File operation path is missing.',
            'File operation path fields disagree.'
        );
        result.paths = [resolveAdapterRelativePath(root, rawPath, cwd)];
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
    let toolCwd;
    if (isObject(raw.toolCall)) {
        const ti = resolveToolCallInput(raw.toolCall);
        toolCwd = isObject(ti) ? ti.Cwd : undefined;
    }
    if (raw.cwd !== undefined && toolCwd !== undefined) {
        insist(
            typeof raw.cwd === 'string' && typeof toolCwd === 'string' && path.isAbsolute(raw.cwd) && path.isAbsolute(toolCwd) && rootOf(raw.cwd) === rootOf(toolCwd),
            'BAD_CWD',
            'Hook cwd fields disagree.'
        );
    }
    return raw.cwd ?? toolCwd;
}

export function normalizeInput(host, raw, root, expectedEvent = null) {
    root = rootOf(root);
    insist(HOSTS.includes(host), 'BAD_HOST', 'Host must be generic, codex, claude or antigravity.');
    if (host === 'generic') {
        validateEvent(raw);
        return validateEvent({ ...raw, paths: [...new Set(raw.paths.map(p => resolveAdapterRelativePath(root, p, root)))] });
    }
    insist(isObject(raw), 'BAD_INPUT', 'Hook input must be an object.');
    const rawEventName = resolveRawEventName(host, raw, expectedEvent);
    const event = typeof rawEventName === 'string' && Object.hasOwn(events, rawEventName) ? events[rawEventName] : null;
    insist(event, 'BAD_EVENT', 'Unsupported host event.');
    const cwd = resolveHookCwd(root, extractHookCwd(raw));
    if (raw.session_id !== undefined && raw.conversationId !== undefined) {
        insist(raw.session_id === raw.conversationId, 'BAD_INPUT', 'session_id and conversationId disagree.');
    }
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
    if (event === 'compact' || event === 'stop' || !result.context)
        return { stdout: '{}', stderr: '', exitCode: 0 };
    const hookEventName = { tool: 'PreToolUse', prompt: 'UserPromptSubmit', session: 'SessionStart' }[event];
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } }), stderr: '', exitCode: 0 };
}

export const eventKind = (hostEvent) => (typeof hostEvent === 'string' && Object.hasOwn(events, hostEvent) ? events[hostEvent] : 'prompt');
