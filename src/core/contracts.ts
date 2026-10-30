/** Platform-neutral domain types: no Jira / monday / Recall shapes leak into orchestration. */
export type ProviderKind = 'demo' | 'recall' | 'slack' | 'teams' | 'zoom' | 'meet';
/** `streaming_speech`: consecutive speak() calls play one after another, so an answer can be spoken while it is written. */
export type Capability = 'listen' | 'speak' | 'streaming_speech' | 'raise_hand' | 'chat_receipt' | 'code_search' | 'create_task' | 'draft_pr';
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
  kind: 'task' | 'code_lookup' | 'draft_pr' | 'message';
  url: string;
  label: string;
}
/** Signals that speech failed after the user-visible meeting-chat mirror was already delivered. */
export class SpeechFallbackSentError extends Error {
  constructor() { super('speech unavailable after chat fallback'); }
}
/** A participant cut Nogita off; `playedMs` is how much of this piece had played (heard) when it stopped. */
export class SpeechInterruptedError extends Error {
  constructor(readonly playedMs?: number) { super('speech interrupted by participant'); }
}
export interface SpeakOptions { chatMirror?: boolean }
export interface MeetingPort {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** Only call for a user-invited meeting. */
  join(meetingUrl?: string): Promise<void>;
  /** Called only for an explicit direct address or a verified reply to Nogita's own recent question.
   *  `chatMirror: false` asks a voice provider not to copy this line to meeting chat (streamed partial speech). */
  speak(message: string, options?: SpeakOptions): Promise<void>;
  /** Stops the speech playing now (its speak() rejects with SpeechInterruptedError); false when nothing was playing. */
  interruptSpeech?(): boolean;
  /** Plain meeting-chat status or speech fallback; never carries secrets. */
  sendStatus(message: string, timeoutMs?: number): Promise<void>;
  /** Returns false if native hand raise is not supported; no fallback speech/chat. */
  raiseHand(): Promise<boolean>;
  /** Only on completion of an explicitly requested task or information lookup. */
  sendCompletion(receipt: ActionReceipt): Promise<void>;
  leave(): Promise<void>;
  /** Recent messages of a text conversation (a Slack thread), oldest first, as "Name: text". */
  recentContext?(): Promise<string[]>;
}
export interface CreateTask {
  title: string;
  description: string;
  assigneeId?: string;
  requestId: string;
  /** Which connected board (id from `BoardPort.boards`); the default board when absent. */
  board?: string;
}
/** A change to an existing task. Each field is optional; at least one is set. */
export interface UpdateTask {
  key: string;
  /** A status as people say it ("In Progress", "done"); the board finds the move that gets there. */
  status?: string;
  /** An id from `findAssignees` or an internal person id, as for `CreateTask.assigneeId`. */
  assigneeId?: string;
  comment?: string;
  requestId: string;
}
export interface TaskSummary {
  key: string;
  title: string;
  status?: string;
  assignee?: string;
  type?: string;
  priority?: string;
  updated?: string;
  url: string;
}
export interface TaskDetail extends TaskSummary {
  description: string;
  reporter?: string;
  created?: string;
  comments: Array<{ author?: string; created?: string; text: string }>;
}
/** A task search any board can answer; each adapter translates it into its own query language. */
export interface TaskSearch {
  text?: string;
  /** A status as people say it ("In Progress", "done"), matched without regard to case. */
  status?: string;
  /** Someone's tasks: an id from `findAssignees`, or an internal person id the board can map. */
  assigneeId?: string;
  /** Only tasks nobody owns. */
  unassigned?: boolean;
  /** One connected board (its id) or project key; every readable one when absent. */
  board?: string;
  /** Raw query for boards that declare `queryLanguage` (Jira: a JQL condition), for what the fields cannot say. */
  jql?: string;
  limit?: number;
}
/** A person a board can assign work to. `id` is accepted back by `createTask` as `assigneeId`. */
export interface AssigneeCandidate { id: string; displayName: string }
export interface BoardPort {
  readonly name: string;
  /** Set when `TaskSearch.jql` is understood. */
  readonly queryLanguage?: 'jql';
  /** Connected boards a task can go to, when there is more than one (ids, for `CreateTask.board`). */
  readonly boards?: ReadonlyArray<{ id: string; name: string }>;
  createTask(input: CreateTask): Promise<ActionReceipt>;
  /** Moves, reassigns or comments on a task in a board Nogita may write to. A retried request changes nothing twice. */
  updateTask?(input: UpdateTask): Promise<ActionReceipt>;
  /** Read-only lookups used by the conversational agent. Optional per provider. */
  searchTasks?(query: TaskSearch): Promise<TaskSummary[]>;
  getTask?(key: string): Promise<TaskDetail | undefined>;
  /** `board`: which connected board the person will be assigned on (the default board when absent). */
  findAssignees?(name: string, board?: string): Promise<AssigneeCandidate[]>;
}
/** A draft pull request asked for out loud: what to change and why, for a person to build on. */
export interface DraftPullRequest { title: string; description: string; requestId: string }
/** Opens draft pull requests on a new branch. Never writes to an existing branch and never merges. */
export interface PullRequestPort {
  readonly name: string;
  openDraft(input: DraftPullRequest): Promise<ActionReceipt>;
}
/** What a meeting decided and who took which action item: sentences people said plainly, never the transcript. */
export interface MeetingRecord {
  /** ISO time the meeting ended. */
  endedAt: string;
  decisions: Array<{ speaker: string; text: string }>;
  actionItems: Array<{ speaker: string; text: string; owner?: string }>;
}
/** Opt-in memory across meetings, so "what did we decide last week about the release?" has an answer. */
export interface MeetingMemoryPort {
  remember(record: MeetingRecord): Promise<void>;
  /** Newest first; records with any of the words, or the latest ones when no words are given. */
  search(words: string, limit?: number): Promise<MeetingRecord[]>;
}
/** Team messaging workspace (Slack today) as a source of context and an explicitly requested action target. */
export interface ChatChannel { id: string; name: string }
export interface ChatMessage { channel: string; author: string; text: string; at: string; url?: string }
export interface ChatPort {
  readonly name: string;
  listChannels(): Promise<ChatChannel[]>;
  readChannel(channel: string, limit?: number): Promise<ChatMessage[]>;
  searchMessages?(query: string, limit?: number): Promise<ChatMessage[]>;
  /** A thread as "Name: text" lines, oldest first (conversation context for a thread Nogita is in). */
  readThread?(channelId: string, threadTs: string, limit?: number): Promise<string[]>;
  postMessage(channel: string, text: string): Promise<ActionReceipt>;
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
/** Work Nogita does in another system, counted per meeting. */
export type ExternalAction = 'create_task' | 'update_task' | 'draft_pr' | 'code_lookup';
export interface UsagePort {
  recordResponse?(sessionId: string, durationMs: number): void;
  recordResponseStage?(sessionId: string, stage: ResponseStage, durationMs: number): void;
  recordTts(sessionId: string, success: boolean): void;
  recordExternalAction(sessionId: string, action: ExternalAction): void;
}
export interface CodePort {
  readonly name: string;
  /** Optional preparation such as warming an in-memory repository index at startup. */
  prepare?(): Promise<void>;
  /** Coverage of supported source files at the last successful index build. */
  getCoverage?(): { indexedFiles: number; skippedLargeFiles: number } | undefined;
  findEvidence(query: string): Promise<Evidence[]>;
  /** Whole-file and history access for the conversational agent. Optional per provider. */
  readFile?(path: string, startLine?: number, endLine?: number): Promise<CodeFile | undefined>;
  listFiles?(prefix?: string): Promise<string[]>;
  recentCommits?(ref?: string): Promise<Evidence[]>;
  /** Small, stable repository map used to prime the agent prompt. */
  overview?(): Promise<{ paths: string[]; readme?: string; revision?: string }>;
}
/** Something Nogita puts on her shared screen when asked (a task, a task list, or code). */
export type ScreenCard =
  | { kind: 'task'; key: string; title: string; status?: string; assignee?: string; type?: string; priority?: string; description?: string; url: string }
  | { kind: 'tasks'; title: string; items: Array<{ key: string; title: string; status?: string; assignee?: string }> }
  | { kind: 'code'; path: string; startLine: number; lines: string[]; url: string };
export interface CodeFile { path: string; url: string; text: string; startLine: number; endLine: number; totalLines: number }
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
  /** Richer, rate-limited assessment used with the agent: whether something critical is being missed, and what. */
  assessContribution?(context: readonly string[], usageContext?: string): Promise<ContributionAssessment>;
}
export interface ContributionAssessment { raise: boolean; reason?: string; topic?: string }
export interface PolicyPort {
  mayReadCode(actor: Actor): boolean;
  mayWriteTask(actor: Actor): boolean;
  mayDraftPR(actor: Actor): boolean;
}
