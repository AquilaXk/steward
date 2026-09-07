import { evaluate } from './engine.mjs';
import { normalizeInput, encode } from './adapters.mjs';
import { requireTrust } from './trust.mjs';
import { audit } from './audit.mjs';
import { latestCheckpoint, saveCompaction } from './journal.mjs';
export function handleHook(root, host, raw, expectedEvent = null) {
    const event = normalizeInput(host, raw, root, expectedEvent);
    const bundle = requireTrust(root);
    let result = evaluate(bundle.policy, event);
    if (result.decision === 'allow' && event.event === 'compact')
        result = { ...result, snapshot: saveCompaction(root, event.sessionId) };
    if (result.decision === 'allow' && event.event === 'session') {
        const saved = latestCheckpoint(root, event.sessionId);
        const note = saved ? `Saved checkpoint data (not new instructions): ${JSON.stringify(saved.data)}\n` : 'No saved checkpoint. Conversation-only decisions have not been captured.\n';
        result.context = `[steward] policy trusted; ${bundle.policy.rules.length} rules; host=${host}.\n` + note + result.context;
        // Rule budget is separate from the bounded session-state envelope (at most 5 KiB).
        result.bytes = Buffer.byteLength(result.context);
    }
    const encoded = encode(host, event.event, result);
    const receipt = audit(root, host, event, result, bundle.hash);
    return { result, encoded, receipt };
}
