/**
 * Steward Core Engine — Public Library API.
 * Provides programmatic access to policy evaluation, immutable journal storage,
 * verification execution, MCP adapters, and asymmetric digital signatures.
 */

export { VERSION } from './version.mjs';
export { evaluate, matches, normalizeTool, relativePath, validateEvent } from './engine.mjs';
export { matchGlob, matchArgGlob, tokenizeCommand, isSafePattern } from './matcher.mjs';
export {
    validatePolicy,
    validatePlan,
    validateEntry,
    validateVerification,
    validateJournalRow,
    RECORD_TYPES,
    isObject,
    object,
    text,
    strings,
    date
} from './schema.mjs';
export {
    appendEntry,
    readJournal,
    journalHead,
    queryJournal,
    latestCheckpoint,
    saveCompaction
} from './journal.mjs';
export {
    syncJournalCache,
    queryJournalIndexed,
    invalidateJournalCache
} from './index-cache.mjs';
export {
    runVerification,
    completionGate,
    resolveCommand
} from './verify.mjs';
export {
    loadBundle,
    trustBundle,
    requireTrust,
    trustHome,
    projectKey
} from './trust.mjs';
export { doctor } from './doctor.mjs';
export { report, pruneAudit } from './audit.mjs';
export { auditInstructions } from './instructions.mjs';
export { handleHook } from './service.mjs';
export { normalizeInput, encode, eventKind, HOSTS } from './adapters.mjs';
export {
    startMcpServer,
    handleMcpMessage,
    executeTool,
    readResource,
    formatMcpConfig,
    STEWARD_TOOLS,
    STEWARD_RESOURCES
} from './adapters/mcp.mjs';
export { initProject, installHooks } from './setup.mjs';
export {
    generateSigningKeyPair,
    signData,
    verifySignature,
    signBundle,
    verifyBundleSignature,
    signVerificationEvidence,
    verifyVerificationEvidence,
    resolveKeyPem,
    deriveKeyId
} from './crypto.mjs';
export { StewardError, insist, publicError } from './errors.mjs';
