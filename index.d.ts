/**
 * TypeScript Type Definitions for Steward
 * Evidence-aware policy, immutable journal, and memory toolkit for coding agents.
 */

export const VERSION: string;

// ==========================================
// Policy Engine & Schema
// ==========================================

export type RuleEvent = 'prompt' | 'tool' | 'session';
export type EventType = RuleEvent | 'compact';
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
    event: EventType;
    text: string;
    tool: string | null;
    paths: string[];
    sessionId: string | null;
}

export interface OmittedRule {
    id: string;
    reason: 'byte_budget' | 'rule_limit';
}

export interface CompactionSnapshot {
    path: string;
    count: number;
    head: string | null;
    hasCheckpoint: boolean;
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
    snapshot?: CompactionSnapshot;
    simulation?: boolean;
    activated?: boolean;
}

export function evaluate(policy: Policy, event: EventInput): EvaluationResult;
export function matches(rule: Rule, event: EventInput, words?: string | null): boolean;
export function normalizeTool(name: string): string;
export function relativePath(root: string, input: string, cwd?: string): string;
export function validateEvent(event: unknown): EventInput;
export function validatePolicy(policy: unknown): Policy;
export function isObject(x: unknown): x is Record<string, unknown>;
export function object(x: unknown, keys: string[], label: string): void;
export function text(x: unknown, label: string, max?: number): void;
export function strings(x: unknown, label: string, options?: { empty?: boolean; max?: number }): void;
export function date(x: unknown, label: string): void;

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

export type UserRecordType =
    | 'decision'
    | 'question'
    | 'knowledge'
    | 'goal'
    | 'checkpoint'
    | 'schedule'
    | 'handoff';

export type RecordType = UserRecordType | 'verification';

export const RECORD_TYPES: readonly UserRecordType[];

export interface DecisionData {
    statement: string;
    authority: {
        kind: 'user' | 'delegated';
        reference: string;
        quote: string;
    };
    supersedes: string | null;
    tags?: string[];
}

export interface QuestionData {
    question: string;
    assumptions: string[];
    resolution: string | null;
    supersedes: string | null;
    tags?: string[];
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
    tags?: string[];
}

export interface GoalData {
    objective: string;
    acceptance: string[];
    status: 'active' | 'blocked' | 'complete';
    evidence: string[];
    tags?: string[];
}

export interface CheckpointData {
    summary: string;
    next: string;
    blockers: string[];
    session?: string | null;
    tags?: string[];
}

export interface ScheduleData {
    title: string;
    dueAt: string;
    status: 'planned' | 'staged' | 'completed' | 'cancelled';
    members: string[];
    id?: string;
    supersedes?: string | null;
    tags?: string[];
}

export interface HandoffData {
    task: string;
    scope: string[];
    constraints: string[];
    acceptance: string[];
    evidence: string[];
    tags?: string[];
}

export type JournalEntryData =
    | DecisionData
    | QuestionData
    | KnowledgeData
    | GoalData
    | CheckpointData
    | ScheduleData
    | HandoffData;

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
    rows: ReadonlyArray<Readonly<JournalRecord>>;
}

export function appendEntry(root: string, entry: { type: UserRecordType; data: JournalEntryData }): Promise<JournalRecord>;
export function readJournal(root: string, options?: { anchor?: { count: number; head: string | null } | null; fresh?: boolean }): JournalRecord[];
export function journalHead(rows: JournalRecord[]): JournalHead;
export function queryJournal(root: string, options?: JournalQueryOptions): JournalQueryResult;
export function latestCheckpoint(root: string, sessionId?: string | null): JournalRecord<CheckpointData> | null;
export function saveCompaction(root: string, sessionId?: string | null): CompactionSnapshot;
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
export function validateEntry(entry: unknown): { type: UserRecordType; data: JournalEntryData };
export function validateVerification(report: unknown): VerificationReport;
export function validateJournalRow(row: unknown): JournalRecord;
export function resolveCommand(cmd: string, env?: Record<string, string | undefined>): string;
export function runVerification(root: string): Promise<VerificationReport & { evidence: string }>;
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

export interface HostStatus {
    host: 'codex' | 'claude';
    status: 'not-installed' | 'broken' | 'configured';
    nativeStatus: string;
    problems: string[];
}

export interface InstructionFinding {
    code: string;
    line: number;
}

export interface InstructionFileReport {
    path: string;
    sha256: string;
    bytes: number;
    findings: InstructionFinding[];
}

export interface InstructionsAuditResult {
    files: InstructionFileReport[];
    inventoryHash: string;
    findingCount: number;
    completeSecurityReview: boolean;
}

export interface DoctorResult {
    healthy: boolean;
    localHealthy: boolean;
    status: 'unchecked' | 'needs-attention';
    bundleHash: string;
    journal: JournalHead;
    instructions: InstructionsAuditResult;
    hosts: HostStatus[];
    liveHostVerified: boolean;
    next: string;
}

export interface AuditRuleSummary {
    id: string;
    effect: RuleEffect;
    matched: number;
    emitted: number;
    omitted: number;
    lastPreparedAt: string | null;
}

export interface AuditReport {
    receipts: number;
    denied: number;
    emitted: Record<string, number>;
    stage: 'prepared';
    hostAcknowledged: boolean;
    current: {
        bundleHash: string;
        receipts: number;
        rules: AuditRuleSummary[];
        neverEmitted: string[];
    };
    retention: {
        limit: number;
        remaining: number;
    };
}

export function loadBundle(root: string): TrustBundle;
export function trustBundle(root: string, digest: string): TrustResult;
export function requireTrust(root: string): TrustBundle;
export function trustHome(): string;
export function projectKey(root: string): string;
export function doctor(root: string, host?: string | null): DoctorResult;
export function report(root: string): AuditReport;
export function pruneAudit(root: string, options?: { keep?: number }): { deleted: number; remaining: number };
export function auditInstructions(root: string): InstructionsAuditResult;

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
export function encode(host: HostType, event: EventType, result: EvaluationResult): EncodedOutput;
export function eventKind(hostEvent?: string | null): EventType;
export function handleHook(root: string, host: HostType, input: unknown, expectedEvent?: string | null): { result: EvaluationResult; encoded: EncodedOutput; receipt: string };

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
export function verifyBundleSignature(root: string, publicKeyInput: string, sigRecord?: SignatureRecord | null): { valid: true; bundleHash: string; signedAt: string; keyId: string; target: 'bundle' };
export function signVerificationEvidence(root: string, evidenceHash: string, privateKeyInput: string): EvidenceSignatureRecord;
export function verifyVerificationEvidence(root: string, evidenceHash: string, publicKeyInput: string, sigRecord?: EvidenceSignatureRecord | null): { valid: true; evidenceHash: string; runId: string; workspaceHash: string; keyId: string; signedAt: string; target: 'evidence' };

// ==========================================
// Setup & Errors
// ==========================================

export interface InitProjectResult {
    project: string;
    profile: string;
    created: string[];
    skipped: string[];
    generated: string[];
    trusted: boolean;
    note: string;
}

export interface InstallHooksResult {
    host: string;
    path?: string;
    installed?: boolean;
    uninstalled?: boolean;
    skills?: { source?: string; created: string[]; skipped: string[]; updated?: string[] };
    removed?: string[];
    preserved?: string[];
    hostTrustRequired?: boolean;
    liveHostVerified?: boolean;
    note?: string;
}

export function initProject(root: string, options?: { plugin?: boolean }): InitProjectResult;
export function installHooks(root: string, host: string, options?: { plugin?: boolean; update?: boolean; uninstall?: boolean }): InstallHooksResult;

export class StewardError extends Error {
    code: string;
    constructor(code: string, message: string);
}

export function insist(condition: unknown, code: string, message: string): asserts condition;
export function publicError(error: unknown): { code: string; message: string };

