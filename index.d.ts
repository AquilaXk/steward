/**
 * TypeScript Type Definitions for Steward
 * Evidence-aware policy, immutable journal, and memory toolkit for coding agents.
 */

export const VERSION: string;

// ==========================================
// Policy Engine & Schema
// ==========================================

export type RuleEvent = 'prompt' | 'tool' | 'session' | 'compact';
export type RuleEffect = 'inject' | 'deny';

export interface RuleMatch {
    always?: true;
    tools?: string[];
    textAny?: string[];
    wordsAny?: string[];
    patternsAny?: string[];
    globsAny?: string[];
    pathPrefixes?: string[];
}

export interface Rule {
    id: string;
    on: RuleEvent[];
    effect: RuleEffect;
    priority: number;
    body: string;
    required: boolean;
    match: RuleMatch;
}

export interface PolicyBudget {
    bytes: number;
    rules: number;
}

export interface Policy {
    version: 1;
    budget: PolicyBudget;
    rules: Rule[];
}

export interface EventInput {
    event: RuleEvent;
    text: string;
    tool: string | null;
    paths: string[];
    sessionId: string | null;
}

export interface OmittedRule {
    id: string;
    reason: 'byte_budget' | 'rule_limit';
}

export interface EvaluationResult {
    decision: 'allow' | 'deny';
    reason: string | null;
    matched: string[];
    emitted: string[];
    omitted: OmittedRule[];
    context: string;
    bytes: number;
    denied?: string[];
    simulation?: boolean;
    activated?: boolean;
}

export function evaluate(policy: Policy, event: EventInput): EvaluationResult;
export function matches(rule: Rule, event: EventInput, words?: string | null): boolean;
export function normalizeTool(name: string): string;
export function relativePath(root: string, input: string, cwd?: string): string;
export function validateEvent(event: unknown): EventInput;
export function validatePolicy(policy: unknown): Policy;

// ==========================================
// Safe Glob & CLI Argument Pattern Matcher
// ==========================================

export interface GlobOptions {
    caseSensitive?: boolean;
    maxSteps?: number;
}

export function matchGlob(pattern: string, text: string, options?: GlobOptions): boolean;
export function matchArgGlob(patterns: string[], text: string, options?: GlobOptions): boolean;
export function tokenizeCommand(text: string): string[];
export function isSafePattern(pattern: string): boolean;

// ==========================================
// Journal & Memory Models
// ==========================================

export type RecordType =
    | 'decision'
    | 'question'
    | 'knowledge'
    | 'goal'
    | 'checkpoint'
    | 'schedule'
    | 'handoff'
    | 'verification';

export const RECORD_TYPES: readonly RecordType[];

export interface DecisionData {
    statement: string;
    authority: {
        kind: 'user' | 'delegated';
        reference: string;
        quote: string;
    };
    supersedes: string | null;
}

export interface QuestionData {
    question: string;
    assumptions: string[];
    resolution: string | null;
    supersedes: string | null;
}

export interface KnowledgeSource {
    reference: string;
    checkedAt: string;
}

export interface KnowledgeData {
    claim: string;
    basis: 'source' | 'observation' | 'assumption';
    sources: KnowledgeSource[];
    expiresAt: string | null;
}

export interface GoalData {
    objective: string;
    acceptance: string[];
    status: 'active' | 'blocked' | 'complete';
    evidence: string[];
}

export interface CheckpointData {
    summary: string;
    next: string;
    blockers: string[];
    session?: string;
}

export interface ScheduleData {
    title: string;
    dueAt: string;
    status: 'planned' | 'staged' | 'completed' | 'cancelled';
    members: string[];
    id?: string;
    supersedes?: string | null;
}

export interface HandoffData {
    task: string;
    scope: string[];
    constraints: string[];
    acceptance: string[];
    evidence: string[];
}

export interface JournalRecord<T = unknown> {
    version: 1;
    seq: number;
    id: string;
    type: RecordType;
    time: string;
    previous: string | null;
    data: T;
    hash: string;
    superseded?: boolean;
    expired?: boolean;
}

export interface JournalHead {
    count: number;
    head: string | null;
}

export interface JournalQueryOptions {
    type?: RecordType;
    text?: string;
    limit?: number;
    history?: boolean;
    recordId?: string;
    sessionId?: string;
    tag?: string;
    since?: string | number;
    until?: string | number;
    now?: number;
}

export interface JournalQueryResult extends JournalHead {
    total: number;
    limit: number;
    truncated: boolean;
    history: boolean;
    rows: JournalRecord[];
}

export function appendEntry(root: string, entry: { type: RecordType; data: unknown }): Promise<JournalRecord>;
export function readJournal(root: string, options?: { anchor?: { count: number; head: string } | null; fresh?: boolean }): JournalRecord[];
export function journalHead(rows: JournalRecord[]): JournalHead;
export function queryJournal(root: string, options?: JournalQueryOptions): JournalQueryResult;
export function latestCheckpoint(root: string, sessionId?: string | null): JournalRecord<CheckpointData> | null;
export function saveCompaction(root: string, sessionId?: string | null): { path: string; count: number; head: string | null; hasCheckpoint: boolean };
export function syncJournalCache(root: string): { rows: JournalRecord[]; cache: unknown };
export function queryJournalIndexed(root: string, options?: JournalQueryOptions): JournalQueryResult;
export function invalidateJournalCache(root: string): void;

// ==========================================
// Verification & Gates
// ==========================================

export interface VerificationCheck {
    id: string;
    description: string;
    argv: string[];
    timeoutMs: number;
}

export interface VerificationPlan {
    version: 1;
    maxAgeSeconds: number;
    exclude?: string[];
    checks: VerificationCheck[];
}

export interface CheckStreamOutput {
    path: string;
    sha256: string;
}

export interface CheckResult {
    id: string;
    status: 'pass' | 'fail' | 'unavailable';
    error: string | null;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    stdout: CheckStreamOutput;
    stderr: CheckStreamOutput;
}

export interface VerificationReport {
    version: 1;
    runId: string;
    bundleHash: string;
    planHash: string;
    workspace: { hash: string; files: number; excluded: string[] };
    workspaceAfter: string;
    sourceUnchanged: boolean;
    runtime: { node: string; platform: string; arch: string };
    checks: CheckResult[];
    allPassed: boolean;
    limitations: string[];
    evidence?: string;
}

export interface CompletionGateResult {
    pass: boolean;
    evidence: string;
    scope: string;
    workspace: string;
}

export function validatePlan(plan: unknown): VerificationPlan;
export function validateEntry(entry: unknown): unknown;
export function validateVerification(report: unknown): VerificationReport;
export function validateJournalRow(row: unknown): JournalRecord;
export function resolveCommand(cmd: string, env?: Record<string, string | undefined>): string;
export function runVerification(root: string): Promise<VerificationReport>;
export function completionGate(root: string, evidence?: string | null): CompletionGateResult;

// ==========================================
// Trust & Diagnostics
// ==========================================

export interface TrustBundle {
    policy: Policy;
    plan: VerificationPlan;
    hash: string;
    policyPath: string;
    planPath: string;
}

export interface TrustResult {
    trusted: boolean;
    bundleHash: string;
}

export interface DoctorResult {
    root: string;
    host: string | null;
    localHealthy: boolean;
    checks: Array<{ name: string; status: 'ok' | 'fail' | 'warn'; message: string }>;
}

export interface AuditReport {
    bundle: { hash: string; ruleCount: number };
    capacity: { usedBytes: number; maxBytes: number; fileCount: number };
    activeRules: Array<{ id: string; effect: RuleEffect; required: boolean }>;
    summary: { evaluatedEvents: number; emittedRules: number; deniedEvents: number };
}

export function loadBundle(root: string): TrustBundle;
export function trustBundle(root: string, digest: string): TrustResult;
export function requireTrust(root: string): TrustBundle;
export function trustHome(): string;
export function projectKey(root: string): string;
export function doctor(root: string, host?: string | null): DoctorResult;
export function report(root: string): AuditReport;
export function pruneAudit(root: string, options?: { keep?: number }): { deleted: number; remaining: number };
export function auditInstructions(root: string): { files: string[]; issues: string[] };

// ==========================================
// Host Adapters & Hooks
// ==========================================

export type HostType = 'generic' | 'codex' | 'claude';
export const HOSTS: readonly HostType[];

export interface EncodedOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export function normalizeInput(host: HostType, raw: unknown, root: string, expectedEvent?: string | null): EventInput;
export function encode(host: HostType, event: RuleEvent, result: EvaluationResult): EncodedOutput;
export function eventKind(hostEvent: string): RuleEvent;
export function handleHook(root: string, host: HostType, input: unknown, expectedEvent?: string | null): { event: EventInput; evaluation: EvaluationResult; encoded: EncodedOutput };

// ==========================================
// MCP Server Adapter
// ==========================================

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface McpResourceDefinition {
    uri: string;
    name: string;
    mimeType: string;
    description: string;
}

export const STEWARD_TOOLS: readonly McpToolDefinition[];
export const STEWARD_RESOURCES: readonly McpResourceDefinition[];

export function handleMcpMessage(root: string, req: unknown): Promise<object | null>;
export function executeTool(root: string, name: string, args?: Record<string, unknown>): Promise<unknown>;
export function readResource(root: string, uri: string): { uri: string; mimeType: string; text: string };
export function formatMcpConfig(options?: { host?: string; project?: string; runner?: string | null }): object;
export function startMcpServer(root: string, streams?: { inStream?: NodeJS.ReadableStream; outStream?: NodeJS.WritableStream }): Promise<void>;

// ==========================================
// Ed25519 Asymmetric Digital Signatures
// ==========================================

export interface SigningKeyPair {
    privateKeyPem: string;
    publicKeyPem: string;
    keyId: string;
}

export interface SignatureRecord {
    version: 1;
    alg: 'ed25519';
    target: 'bundle';
    bundleHash: string;
    keyId: string;
    signedAt: string;
    signature: string;
}

export interface EvidenceSignatureRecord {
    version: 1;
    alg: 'ed25519';
    target: 'evidence';
    evidenceHash: string;
    runId: string;
    workspaceHash: string;
    keyId: string;
    signedAt: string;
    signature: string;
}

export function generateSigningKeyPair(): SigningKeyPair;
export function deriveKeyId(publicKeyPem: string): string;
export function signData(data: string | Buffer | object, privateKeyPem: string): { alg: string; signature: string };
export function verifySignature(data: string | Buffer | object, signatureHex: string, publicKeyPem: string): boolean;
export function resolveKeyPem(input: string): string;
export function loadKeypair(input: string): string | { privateKeyPem: string; publicKeyPem: string; keyId: string };
export function saveKeypair(outDir: string, keyPair: { privateKeyPem: string; publicKeyPem: string; keyId?: string }): { out: string; privPath: string; pubPath: string; keyId: string };
export function signBundle(root: string, privateKeyPem: string): SignatureRecord;
export function verifyBundleSignature(root: string, publicKeyInput: string, sigRecord?: SignatureRecord | null): { valid: boolean; bundleHash: string; signedAt: string; keyId: string };
export function signVerificationEvidence(root: string, evidenceHash: string, privateKeyInput: string): EvidenceSignatureRecord;
export function verifyVerificationEvidence(root: string, evidenceHash: string, publicKeyInput: string, sigRecord?: EvidenceSignatureRecord | null): { valid: boolean; evidenceHash: string; keyId: string; signedAt: string };

// ==========================================
// Setup & Errors
// ==========================================

export function initProject(root: string, options?: { plugin?: boolean }): { initialized: boolean; files: string[] };
export function installHooks(root: string, host: string, options?: { plugin?: boolean; update?: boolean; uninstall?: boolean }): { installed: boolean; files: string[] };

export class StewardError extends Error {
    code: string;
    constructor(code: string, message: string);
}

export function insist(condition: unknown, code: string, message: string): asserts condition;
export function publicError(error: unknown): { code: string; message: string };
