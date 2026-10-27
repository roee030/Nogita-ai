/** Platform-neutral domain types: no Jira / monday / Recall shapes leak into orchestration. */
export type ProviderKind = 'demo' | 'recall' | 'slack' | 'teams' | 'zoom' | 'meet';
export type Capability = 'listen' | 'speak' | 'raise_hand' | 'chat_receipt' | 'code_search' | 'create_task' | 'draft_pr';

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
export interface MeetingPort {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** Only call for a user-invited meeting. */
  join(meetingUrl?: string): Promise<void>;
  /** Called exclusively in response to an explicit direct address. */
  speak(message: string): Promise<void>;
  /** Plain meeting-chat status or speech fallback; never carries secrets. */
  sendStatus(message: string): Promise<void>;
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
export interface AiUsage {
  model: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}
export interface UsagePort {
  recordTts(sessionId: string, success: boolean): void;
  recordExternalAction(sessionId: string, action: 'create_task' | 'code_lookup'): void;
}
export interface CodePort {
  readonly name: string;
  findEvidence(query: string): Promise<Evidence[]>;
}
export type Plan =
  | { kind: 'answer'; message: string }
  | { kind: 'inspect_code'; query: string }
  | { kind: 'create_task'; title: string; description: string; assigneeId?: string }
  | { kind: 'draft_pr'; instruction: string };
export interface BrainPort {
  plan(current: string, ephemeralContext: readonly string[], usageContext?: string): Promise<Plan>;
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
