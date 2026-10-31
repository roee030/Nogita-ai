/**
 * Provider-neutral conversational agent loop.
 *
 * The model answers in its own words and may call tools; the toolbox (agent-tools.ts) executes every
 * tool call, so permissions, explicit-request checks and idempotency stay outside the model.
 * Text is streamed: complete sentences are handed to `onSpeech` while the model is still writing,
 * so a voice meeting hears the first sentence long before the whole answer exists.
 */

export type AgentContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export interface AgentMessage { role: 'user' | 'assistant'; content: string | AgentContent[] }
export interface AgentToolSpec { name: string; description: string; input_schema: Record<string, unknown> }
export interface ChatModelRequest {
  /** Stable part of the system prompt; providers may cache it together with the tool list. */
  stableSystem: string;
  /** Per-turn part of the system prompt (speaker, time, mode). */
  turnSystem: string;
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  maxTokens: number;
  usageContext?: string;
  timeoutMs?: number;
  /** Aborts the request (a cancelled question, or a speculative start that was rolled back). */
  signal?: AbortSignal;
}
export interface ChatModelResponse { content: AgentContent[]; stopReason: string }
export interface ChatModel {
  readonly agentModel: string;
  streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse>;
  /** Optional: prime the provider's prompt cache with the stable prompt and tools. */
  warmCache?(request: { stableSystem: string; tools: AgentToolSpec[]; usageContext?: string }): Promise<void>;
}
export interface ToolOutcome { content: string; isError?: boolean }
export interface AgentToolbox {
  readonly specs: AgentToolSpec[];
  /** Tools that change something outside Nogita run one at a time; reads run in parallel. */
  isWrite(name: string): boolean;
  run(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
}
export interface AgentTurn {
  stableSystem: string;
  turnSystem: string;
  messages: AgentMessage[];
  toolbox: AgentToolbox;
  /** Called with ready-to-speak text, in order: sentence chunks when `stream` is true, otherwise each
   *  lead-in once its step ends and the final answer once it is complete. `step` is the model step (0 first). */
  onSpeech?: (text: string, step: number) => void;
  /** Called before tools run; text already spoken in this step was a lead-in. */
  onToolUse?: (names: string[], step: number) => void;
  /** Time from each model request to its first nonempty text delta (not tool/thinking tokens). */
  onFirstText?: (step: number, ms: number) => void;
  /** Awaited before any write tool runs (a speculative start may not change anything until it is confirmed). */
  beforeWrite?: () => Promise<void>;
  signal?: AbortSignal;
  stream: boolean;
  usageContext?: string;
  maxSteps?: number;
  /** Output budget of a step that cannot call tools (the last one), and the default for the others. */
  maxTokens?: number;
  /** Output budget of a step that may call tools: several whole tool calls need more room than a spoken answer.
   *  How much of an answer is spoken is limited by the caller, not by this budget. */
  toolStepMaxTokens?: number;
  /** Overall budget for the turn; the loop stops calling the model after it. */
  deadlineMs?: number;
  now?: () => number;
}
export interface AgentResult {
  /** Text of the final model step: the answer itself. */
  answer: string;
  /** Text spoken before tool calls ("Let me check the retry worker."). */
  preface: string;
  toolCalls: string[];
  /** What each lookup returned, shortened: kept with the answer so the next turn can still see what it rested on. */
  lookups: string[];
  steps: number;
  stoppedEarly: boolean;
  /** One entry per model request, in order, so a trace can show why each step ended. */
  stops: AgentStepStop[];
}
export interface AgentStepStop {
  step: number;
  /** The provider's stop reason: 'end_turn', 'tool_use', 'max_tokens', ... */
  stopReason: string;
  maxTokens: number;
  /** A tool call cut off by `max_tokens`; it was not run. */
  droppedToolCall?: string;
  /** This request repeated the step with twice the budget: the first attempt was cut off before any whole tool call. */
  retry?: boolean;
}

const MAX_LOOKUP_NOTE_CHARS = 600;

const MAX_TOOL_RESULT_CHARS = 14_000;

/**
 * Splits streamed text into speakable chunks: the first complete sentence as soon as it exists (lowest
 * time to first audio), later sentences batched so the voice does not stutter between tiny fragments.
 */
export class SpeechChunker {
  private buffer = '';
  private emitted = 0;
  constructor(private readonly emit: (text: string) => void, private readonly batchChars = 180) {}
  push(delta: string): void {
    this.buffer += delta;
    if (this.emitted === 0) {
      const end = sentenceEnd(this.buffer);
      if (end < 0) return;
      const first = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (first) this.out(first);
    }
    // Later sentences go out in batches of complete sentences.
    let last = -1;
    for (let end = sentenceEnd(this.buffer); end >= 0; end = sentenceEnd(this.buffer, end)) last = end;
    if (last < 0) return;
    const ready = this.buffer.slice(0, last).trim();
    if (ready.length < this.batchChars) return;
    this.buffer = this.buffer.slice(last);
    this.out(ready);
  }
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.out(rest);
  }
  private out(text: string): void {
    this.emitted++;
    this.emit(text);
  }
}

/** Index just past the first sentence terminator at or after `from`, or -1. */
function sentenceEnd(text: string, from = 0): number {
  const pattern = /[.!?…](?:["')\]]*)(?=\s)|\n\s*\n/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const before = text.slice(Math.max(0, match.index - 4), match.index + 1);
    // Do not split "e.g.", "i.e.", "v1.2" or file names like "engine.ts".
    if (/\b(?:e\.g|i\.e|etc|vs|Mr|Ms|Dr)\.$/i.test(before)) continue;
    const end = match.index + match[0].length;
    if (end <= from) continue;
    return end;
  }
  return -1;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters]`
    : text;
}

export async function runAgent(model: ChatModel, turn: AgentTurn): Promise<AgentResult> {
  const now = turn.now ?? Date.now;
  const started = now();
  const deadline = turn.deadlineMs ?? 60_000;
  const maxSteps = turn.maxSteps ?? 8;
  const answerTokens = turn.maxTokens ?? 900;
  const toolStepTokens = turn.toolStepMaxTokens ?? answerTokens;
  const messages = turn.messages.slice();
  const toolCalls: string[] = [];
  const prefaces: string[] = [];
  const lookups: string[] = [];
  const stops: AgentStepStop[] = [];
  let answer = '';
  let steps = 0;
  const result = (stoppedEarly: boolean): AgentResult =>
    ({ answer, preface: prefaces.join(' '), toolCalls, lookups, steps, stoppedEarly, stops });
  for (; steps < maxSteps; steps++) {
    turn.signal?.throwIfAborted();
    if (deadline - (now() - started) < 1_500) return result(true);
    const step = steps;
    const lastStep = steps === maxSteps - 1;
    let firstText = false;
    let spoken = '';
    const request = async (maxTokens: number, retry: boolean) => {
      // A retry does not stream when the first attempt already spoke: the lead-in is not said twice.
      const chunker = turn.stream && turn.onSpeech && !spoken ? new SpeechChunker(text => turn.onSpeech!(text, step)) : undefined;
      const requestStarted = now();
      const response = await model.streamChat({
        stableSystem: turn.stableSystem,
        turnSystem: lastStep
          ? `${turn.turnSystem}\nThis is your last step: answer now with what you have; do not call tools.`
          : turn.turnSystem,
        messages, tools: lastStep ? [] : turn.toolbox.specs, maxTokens,
        usageContext: turn.usageContext, timeoutMs: Math.min(30_000, deadline - (now() - started)), signal: turn.signal,
      }, delta => {
        if (turn.signal?.aborted) return;
        if (delta.length && !firstText) {
          firstText = true;
          turn.onFirstText?.(step, Math.max(0, now() - requestStarted));
        }
        chunker?.push(delta);
      });
      chunker?.flush();
      const text = response.content.filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text).join('').trim();
      if (chunker) spoken = text;
      const calls = wholeToolCalls(response);
      stops.push({ step, stopReason: response.stopReason, maxTokens,
        ...(calls.dropped ? { droppedToolCall: calls.dropped.name } : {}), ...(retry ? { retry: true } : {}) });
      return { response, text, ...calls };
    };
    const budget = lastStep ? answerTokens : toolStepTokens;
    let attempt = await request(budget, false);
    if (attempt.dropped && !attempt.uses.length && deadline - (now() - started) >= 1_500) {
      // Cut off inside its only tool call: one more try with room for it.
      turn.signal?.throwIfAborted();
      attempt = await request(budget * 2, true);
      // What was already said before tools stays the lead-in.
      if (spoken && attempt.uses.length) attempt.text = spoken;
    }
    const { response, text, uses, dropped } = attempt;
    if (turn.onSpeech && text && (!turn.stream || text !== spoken)) turn.onSpeech(text, step);
    if (!uses.length) {
      answer = text;
      steps++;
      // A tool call that was still cut off after the retry did not run: the turn did not finish.
      return result(dropped !== undefined);
    }
    if (text) prefaces.push(text);
    turn.onToolUse?.(uses.map(use => use.name), step);
    turn.signal?.throwIfAborted();
    messages.push({ role: 'assistant', content: dropped ? response.content.filter(block => block !== dropped) : response.content });
    const results = new Map<string, ToolOutcome>();
    const reads = uses.filter(use => !turn.toolbox.isWrite(use.name));
    const writes = uses.filter(use => turn.toolbox.isWrite(use.name));
    await Promise.all(reads.map(async use => { results.set(use.id, await safeRun(turn.toolbox, use)); }));
    if (writes.length && turn.beforeWrite) await waitForGate(turn.beforeWrite(), turn.signal);
    turn.signal?.throwIfAborted();
    for (const use of writes) {
      turn.signal?.throwIfAborted();
      results.set(use.id, await safeRun(turn.toolbox, use));
    }
    toolCalls.push(...uses.map(use => use.name));
    for (const use of uses) {
      const outcome = results.get(use.id)!;
      const content = (outcome.content || '(empty)').replace(/\s+/g, ' ');
      lookups.push(`${use.name} ${JSON.stringify(use.input ?? {}).slice(0, 160)}${outcome.isError ? ' failed' : ''}: ` +
        (content.length > MAX_LOOKUP_NOTE_CHARS ? `${content.slice(0, MAX_LOOKUP_NOTE_CHARS)}...` : content));
    }
    messages.push({ role: 'user', content: [
      ...uses.map(use => {
        const outcome = results.get(use.id)!;
        return { type: 'tool_result' as const, tool_use_id: use.id, content: truncate(outcome.content || '(empty)'),
          ...(outcome.isError ? { is_error: true } : {}) };
      }),
      ...(dropped ? [{ type: 'text' as const, text: `Your ${dropped.name} call was cut off by the output limit and did not run. ` +
        'Call it again if it is still needed.' }] : []),
    ] });
  }
  return result(false);
}

type ToolUse = Extract<AgentContent, { type: 'tool_use' }>;

/**
 * The tool calls that were written out whole. Output cut off by `max_tokens` ends inside its last block, so a tool
 * call there is incomplete (its input partial or unreadable) and must not run; every earlier call is whole.
 */
function wholeToolCalls(response: ChatModelResponse): { uses: ToolUse[]; dropped?: ToolUse } {
  const uses = response.content.filter(block => block.type === 'tool_use') as ToolUse[];
  if (response.stopReason === 'tool_use') return { uses };
  const last = response.content.at(-1);
  if (response.stopReason === 'max_tokens' && last?.type === 'tool_use') return { uses: uses.slice(0, -1), dropped: last };
  // Any other stop reason ('end_turn', 'refusal', ...) does not ask for tools to run.
  return { uses: [] };
}

/** A rolled-back speculative attempt must not remain suspended behind an unopened write gate. */
async function waitForGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return gate;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { await Promise.race([gate, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function safeRun(toolbox: AgentToolbox, use: { name: string; input: Record<string, unknown> }): Promise<ToolOutcome> {
  try { return await toolbox.run(use.name, use.input ?? {}); }
  catch (error) {
    return { content: `Tool failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`, isError: true };
  }
}
