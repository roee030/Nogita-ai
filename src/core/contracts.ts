/** Platform-neutral domain types: no Jira / monday / Recall shapes leak into orchestration. */
export type ProviderKind = 'demo' | 'recall' | 'slack' | 'teams' | 'zoom' | 'meet';
export type Capability = 'listen' | 'speak' | 'raise_hand' | 'chat_receipt' | 'code_search' | 'create_task' | 'draft_pr';
export type SpeechStage = 'chat_mirror' | 'tts_synthesis' | 'audio_submission' | 'speech_submission';
export type ResponseStage = 'transcript_to_chat_ack' | 'model_roundtrip' | 'turn_to_first_speech_attempt';

export interface Actor {
  id: string;
  displayName: string;
  verified: boolean;
  // This ID must be mapped from provider-trusted identity, never model-generated.
}
export interface Utterance {
  eventId: string;
  actor: Actor;
  text: string;
  at?: number;
}
export interface ActionReceipt {
  provider: string;
  kind: 'task' | 'code_lookup' | 'draft_pr';
  url: string;
  label: string;
}
/** Signals that speech failed after the user-visible meeting-chat mirror was already delivered. */
export class SpeechFallbackSentError extends Error {
  constructor() { super('speech unavailable after chat fallback'); }
}
export interface MeetingPort {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** Only call for a user-invited meeting. */
  join(meetingUrl?: string): Promise<void>;
  /** Called only for an explicit direct address or a verified reply to Nogita's own recent question. */
  speak(message: string): Promise<void>;
  /** Plain meeting-chat status or speech fallback; never carries secrets. */
  sendStatus(message: string, timeoutMs?: number): Promise<void>;
  /** Returns false if native hand raise is not supported; no fallback speech/chat. */
  raiseHand(): Promise<boolean>;
  /** Only on completion of an explicitly requested task or information lookup. */
  sendCompletion(receipt: ActionReceipt): Promise<void>;
  leave(): Promise<void>;
}
export interface CreateTask {
  title: string;
  description: string;
  assigneeId?: string;
  requestId: string;
}
export interface BoardPort {
  readonly name: string;
  createTask(input: CreateTask): Promise<ActionReceipt>;
}
export interface Evidence { path: string; url: string; excerpt: string; }
export interface ConversationTurn { role: 'user' | 'assistant'; text: string; }
export class CodeLookupRateLimitError extends Error {
  constructor() { super('GitHub API rate limit reached'); this.name = 'CodeLookupRateLimitError'; }
}
/** A completed model response that cannot safely be interpreted as a plan; repeating the same event is not useful. */
export class InvalidPlanningResponseError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidPlanningResponseError'; }
}
export interface AiUsage {
  model: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  modelBreakdown?: Array<{ model: string; modelCalls: number; inputTokens: number;
    outputTokens: number; estimatedUsd: number }>;
}
export interface UsagePort {
  recordResponse?(sessionId: string, durationMs: number): void;
  recordResponseStage?(sessionId: string, stage: ResponseStage, durationMs: number): void;
  recordTts(sessionId: string, success: boolean): void;
  recordExternalAction(sessionId: string, action: 'create_task' | 'code_lookup'): void;
}
export interface CodePort {
  readonly name: string;
  /** Optional preparation such as warming an in-memory repository index at startup. */
  prepare?(): Promise<void>;
  /** Coverage of supported source files at the last successful index build. */
  getCoverage?(): { indexedFiles: number; skippedLargeFiles: number } | undefined;
  findEvidence(query: string): Promise<Evidence[]>;
}
export type Plan =
  | { kind: 'answer'; message: string; evidence?: Evidence; evidenceQuote?: string }
  | { kind: 'inspect_code'; query: string }
  | { kind: 'create_task'; title: string; description: string; assigneeId?: string }
  | { kind: 'draft_pr'; instruction: string };
export interface BrainPort {
  /** Keep active meeting accounting and model budgets until the session actually ends. */
  beginUsageSession?(sessionId: string): void;
  endUsageSession?(sessionId: string): void;
  plan(current: string, ephemeralContext: readonly string[], usageContext?: string,
    evidence?: readonly Evidence[], conversation?: readonly ConversationTurn[]): Promise<Plan>;
  answerWithEvidence(question: string, evidence: readonly Evidence[], usageContext?: string): Promise<string>;
  usageFor?(usageContext: string): AiUsage;
  /** Assesses silent participation; must not trigger any mutating action. */
  suggestContribution(context: readonly string[]): Promise<boolean>;
}
export interface PolicyPort {
  mayReadCode(actor: Actor): boolean;
  mayWriteTask(actor: Actor): boolean;
  mayDraftPR(actor: Actor): boolean;
}
