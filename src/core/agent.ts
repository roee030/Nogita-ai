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
   *  lead-in once its step ends and the final answer once it is complete. */
  onSpeech?: (text: string) => void;
  stream: boolean;
  usageContext?: string;
  maxSteps?: number;
  maxTokens?: number;
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
  steps: number;
  stoppedEarly: boolean;
}

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
  const maxSteps = turn.maxSteps ?? 8;
  const messages = turn.messages.slice();
  const toolCalls: string[] = [];
  const prefaces: string[] = [];
  let answer = '';
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const remaining = (turn.deadlineMs ?? 60_000) - (now() - started);
    if (remaining < 1_500) return { answer, preface: prefaces.join(' '), toolCalls, steps, stoppedEarly: true };
    const chunker = turn.stream && turn.onSpeech ? new SpeechChunker(turn.onSpeech) : undefined;
    const lastStep = steps === maxSteps - 1;
    const response = await model.streamChat({
      stableSystem: turn.stableSystem,
      turnSystem: lastStep
        ? `${turn.turnSystem}\nThis is your last step: answer now with what you have; do not call tools.`
        : turn.turnSystem,
      messages, tools: lastStep ? [] : turn.toolbox.specs, maxTokens: turn.maxTokens ?? 900,
      usageContext: turn.usageContext, timeoutMs: Math.min(30_000, remaining),
    }, delta => chunker?.push(delta));
    chunker?.flush();
    const text = response.content.filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text).join('').trim();
    if (!turn.stream && turn.onSpeech && text) turn.onSpeech(text);
    const uses = response.content.filter(block => block.type === 'tool_use') as
      Array<Extract<AgentContent, { type: 'tool_use' }>>;
    if (!uses.length || response.stopReason !== 'tool_use') {
      answer = text;
      steps++;
      break;
    }
    if (text) prefaces.push(text);
    messages.push({ role: 'assistant', content: response.content });
    const results = new Map<string, ToolOutcome>();
    const reads = uses.filter(use => !turn.toolbox.isWrite(use.name));
    const writes = uses.filter(use => turn.toolbox.isWrite(use.name));
    await Promise.all(reads.map(async use => { results.set(use.id, await safeRun(turn.toolbox, use)); }));
    for (const use of writes) results.set(use.id, await safeRun(turn.toolbox, use));
    toolCalls.push(...uses.map(use => use.name));
    messages.push({ role: 'user', content: uses.map(use => {
      const outcome = results.get(use.id)!;
      return { type: 'tool_result' as const, tool_use_id: use.id, content: truncate(outcome.content || '(empty)'),
        ...(outcome.isError ? { is_error: true } : {}) };
    }) });
  }
  return { answer, preface: prefaces.join(' '), toolCalls, steps, stoppedEarly: false };
}

async function safeRun(toolbox: AgentToolbox, use: { name: string; input: Record<string, unknown> }): Promise<ToolOutcome> {
  try { return await toolbox.run(use.name, use.input ?? {}); }
  catch (error) {
    return { content: `Tool failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`, isError: true };
  }
}
