/**
 * Per-turn diagnostics for real meetings: one JSON line per event (what was heard, how it was handled, each question's
 * status, tools, speech start and end, interruptions, what the presence screen showed, provider errors), so a meeting
 * can be replayed into a release report (tools/turn-report.ts).
 *
 * Transcripts are not kept (docs/SECURITY.md): by default a line holds word counts and hashed speaker ids, never words
 * or names. NOGITA_TURN_LOG=full adds them for a test meeting whose participants agreed; NOGITA_TURN_LOG=off disables it.
 */
import { createHmac } from 'node:crypto';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResult, AgentStepStop } from '../core/agent.ts';

export type TurnLogMode = 'off' | 'redacted' | 'full';

export type TurnLogEvent =
  | { type: 'session'; phase: 'start' | 'restore' | 'end' }
  | { type: 'heard'; speaker: string; addressed: boolean; verified: boolean; words: number; confidence?: number; text?: string; inputTurnId?: string }
  | { type: 'turn'; speaker: string; addressed: boolean; words: number; result: string; ms: number; text?: string }
  | { type: 'question'; id: number; status: string; speaker: string; detail?: string; request?: string; inputTurnIds?: string[] }
  | { type: 'tool'; id?: number; tools: string[] }
  | AgentTraceEvent
  | { type: 'model_first_text'; id?: number; step: number; ms: number }
  | { type: 'eot'; speaker: string; phase: 'eager' | 'confirmed' | 'resumed'; sinceLastVoiceMs?: number; inputTurnId?: string }
  | { type: 'speech'; id: number; playbackId?: number; phase: 'start' | 'end'; outcome?: string; heardMs?: number }
  | { type: 'audio'; id?: number; playbackId?: number; phase: 'start' | 'end'; outcome?: string; playedMs?: number; ttfaMs?: number }
  | { type: 'audio_pause'; id?: number; playbackId?: number; latencyMs: number; playedMs: number }
  | { type: 'interrupt'; cause: string; latencyMs?: number; playedMs: number; id?: number; playbackId?: number }
  | { type: 'ui'; state: string; status: string; open: number }
  | { type: 'stale_question'; id: number }
  | { type: 'mission'; id: string; status: string; activity?: string }
  | { type: 'error'; code: string };

export interface AgentTraceEvent {
  type: 'agent_trace';
  id?: number;
  model: string;
  ms: number;
  steps: number;
  stoppedEarly: boolean;
  tools: Array<{ name: string; input: string }>;
  stops: Array<AgentStepStop & { ms?: number }>;
  error?: 'aborted' | 'model_error';
  stepMs?: number[];
  research?: {
    sources: Array<{ id: string; kind: string; tool: string; step: number; cited: boolean }>;
    claims: { total: number; sourced: number };
    truncatedResults: Array<{ tool: string; resultId: string; omittedItems: number; omittedLines: number }>;
  };
}

const MAX_TOOL_INPUT_CHARS = 160;

/** Builds an operational trace without copying answer, preface, lookup output, or transcript text. */
export function buildTurnTrace(input: { id?: number; model: string; ms: number; result?: AgentResult;
  toolUses: ReadonlyArray<{ name: string; input: Record<string, unknown> }>; stepMs: readonly number[];
  error?: 'aborted' | 'model_error' }): AgentTraceEvent {
  const stops = input.result?.stops.map((stop, index) => ({ ...stop,
    ...(input.stepMs[index] !== undefined ? { ms: input.stepMs[index] } : {}) })) ?? [];
  const evidence = input.result?.evidence;
  const resultTruncations = input.result?.resultTruncations ?? [];
  const research = evidence || resultTruncations.length ? {
    sources: evidence?.sources.map(source => ({ id: source.id, kind: source.kind, tool: source.tool, step: source.step,
      cited: evidence.cited.includes(source.id) })) ?? [],
    claims: evidence ? claimCoverage(input.result?.answer ?? '') : { total: 0, sourced: 0 },
    truncatedResults: resultTruncations,
  } : undefined;
  return {
    type: 'agent_trace', ...(input.id !== undefined ? { id: input.id } : {}), model: input.model,
    ms: input.ms, steps: input.result?.steps ?? input.stepMs.length, stoppedEarly: input.result?.stoppedEarly ?? true,
    tools: input.toolUses.map(use => ({ name: use.name, input: shortenInput(use.input) })),
    stops, ...(research ? { research } : {}), ...(input.error ? { error: input.error, stepMs: [...input.stepMs] } : {}),
  };
}

function claimCoverage(answer: string): { total: number; sourced: number } {
  const body = answer.split(/\n\s*Sources:\s*\n/i)[0] ?? '';
  const claims = body.split(/(?<=[.!?…])(?:["')\]]*)\s+/).map(part => part.trim()).filter(part => /[\p{L}\p{N}]/u.test(part));
  return { total: claims.length, sourced: claims.filter(claim => /\[\d+(?:\s*,\s*\d+)*\](?:[.!?…])?$/.test(claim)).length };
}

function shortenInput(value: Record<string, unknown>): string {
  let serialized: string;
  try { serialized = JSON.stringify(redactStrings(value, new WeakSet<object>())); } catch { serialized = '[unserializable]'; }
  return serialized.length > MAX_TOOL_INPUT_CHARS ? `${serialized.slice(0, MAX_TOOL_INPUT_CHARS)}…` : serialized;
}

function redactStrings(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return `[string:${value.length}]`;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactStrings(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactStrings(item, seen)]));
}

/** Text fields dropped unless the log is in full mode. */
const TEXT_FIELDS = ['text', 'request', 'detail'] as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function parseTurnLogMode(value: string | undefined): TurnLogMode {
  return value === 'off' || value === 'full' ? value : 'redacted';
}

export class TurnLog {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly full = new Set<string>();
  private ready?: Promise<void>;

  constructor(private readonly directory: string, readonly mode: TurnLogMode, private readonly secret: string,
    private readonly now: () => number = Date.now) {}

  get enabled(): boolean { return this.mode !== 'off'; }

  /** A person as the log shows them: a stable pseudonym, or the name itself in full mode. */
  person(name: string): string {
    return this.mode === 'full' ? name : `p_${this.hash(`person\0${name}`).slice(0, 10)}`;
  }

  record(sessionId: string, event: TurnLogEvent): void {
    if (!this.enabled) return;
    const line: Record<string, unknown> = { at: this.now(), ...event };
    if (this.mode !== 'full') {
      for (const field of TEXT_FIELDS) {
        // Details are fixed phrases from the engine, except where they could quote speech.
        if (field === 'detail' && typeof line.detail === 'string' && !/"/.test(line.detail)) continue;
        delete line[field];
      }
    }
    const file = join(this.directory, 'turns', `${this.hash(`session\0${sessionId}`).slice(0, 24)}.jsonl`);
    const previous = this.writes.get(file) ?? Promise.resolve();
    const next = previous.then(() => this.append(file, `${JSON.stringify(line)}\n`)).catch(() => undefined);
    this.writes.set(file, next);
  }

  /** Waits for every line written so far (tests, shutdown). */
  async flush(): Promise<void> { await Promise.all(this.writes.values()); }

  private async append(file: string, line: string): Promise<void> {
    if (this.full.has(file)) return;
    this.ready ??= mkdir(join(this.directory, 'turns'), { recursive: true }).then(() => undefined);
    await this.ready;
    const size = await stat(file).then(info => info.size, () => 0);
    if (size + line.length > MAX_FILE_BYTES) { this.full.add(file); return; }
    await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
  }

  private hash(value: string): string {
    return createHmac('sha256', this.secret || 'nogita-turn-log').update(value).digest('hex');
  }
}
