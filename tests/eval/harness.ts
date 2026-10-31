/**
 * Runs an eval case through the real engine and agent loop (voice budgets, write checks, follow-ups) against the
 * in-memory world, and scores it. The model is whatever ChatModel is passed: the real one for `npm run eval`, a
 * scripted one in tests.
 */
import { NogitaEngine } from '../../src/core/engine.ts';
import { AllowlistPolicy } from '../../src/core/policy.ts';
import { DemoBrain, DemoMeeting } from '../../src/adapters/demo.ts';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../../src/core/agent.ts';
import type { ActionReceipt, Capability, SpeakOptions } from '../../src/core/contracts.ts';
import { DIMENSIONS, type CaseRun, type Check, type Dimension, type EvalCase, type WriteMethod, said } from './cases.ts';
import { NOW, SPEAKERS, TEAM, evalWorld, isWrite } from './world.ts';

/** Spoken words in one answer above which it is no longer short (the voice prompt asks for about 20). */
const MAX_SPOKEN_WORDS = 75;
const REASONING_ALOUD = /\b(?:I should|I need to (?:check|look|find)|let me think|this is a question about|the user (?:is|wants|asked))\b/i;

class TracedModel implements ChatModel {
  readonly tools: string[] = [];
  readonly stops: string[] = [];
  constructor(private readonly inner: ChatModel) {}
  get agentModel(): string { return this.inner.agentModel; }
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const response = await this.inner.streamChat(request, onText);
    this.stops.push(response.stopReason);
    for (const block of response.content) if (block.type === 'tool_use') this.tools.push(block.name);
    return response;
  }
}

class EvalMeeting extends DemoMeeting {
  spoken: string[] = [];
  chat: string[] = [];
  readonly receipts: ActionReceipt[] = [];
  constructor(id: string, override readonly capabilities: ReadonlySet<Capability>) { super(id); }
  override async speak(message: string, _options: SpeakOptions = {}): Promise<void> { this.spoken.push(message); }
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
  override async sendCompletion(receipt: ActionReceipt): Promise<void> {
    this.receipts.push(receipt);
    await this.sendStatus(`${receipt.label}: ${receipt.url}`);
  }
}

export async function runCase(model: ChatModel, item: EvalCase): Promise<CaseRun> {
  const world = evalWorld();
  const traced = new TracedModel(model);
  const voice = (item.mode ?? 'voice') === 'voice';
  const meeting = new EvalMeeting(item.id, new Set<Capability>(voice ? ['listen', 'speak', 'streaming_speech', 'chat_receipt'] : ['chat_receipt']));
  // Time starts at the frozen moment and runs at real speed, so timers inside the engine still behave.
  const started = Date.now();
  // Kept across a restart, as NOGITA_DURABLE_RECEIPTS keeps them on disk.
  const receipts = new Map<string, ActionReceipt>();
  const newEngine = () => new NogitaEngine({ board: world.ports.board, code: world.ports.code, chat: world.ports.chat, brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: traced, people: world.people, tenant: TEAM },
  { progressDelayMs: 60_000, agentProgressDelayMs: 60_000, agentCacheWarmup: false, now: () => NOW + Date.now() - started, receipts,
    schedule: (work, delayMs) => { const timer = setTimeout(() => { void work(); }, delayMs); timer.unref(); return timer; } });
  let engine = newEngine();
  const actor = SPEAKERS[item.speaker ?? 'roee'];
  const run: CaseRun = { turns: [], receipts: meeting.receipts, calls: world.calls, tools: traced.tools, stops: traced.stops,
    board: world.board, posted: world.chat.posted, ms: 0 };
  const deliver = async (text: string, eventId: string) => {
    meeting.spoken = [];
    meeting.chat = [];
    const result = await engine.onUtterance(item.id, { eventId, text, actor });
    run.turns.push({ text, result, spoken: meeting.spoken, chat: meeting.chat, tasksAfter: world.board.tasks.length });
  };
  await engine.startSession(item.id, meeting);
  try {
    for (const [index, text] of item.turns.entries()) await deliver(text, `${item.id}-${index}`);
    if (item.retry) {
      // The meeting provider delivers the last utterance again, with the same event id; after a restart the process
      // lost the session and its seen events, and only the stored receipts remain.
      if (item.retry === 'restart') {
        engine = newEngine();
        await engine.startSession(item.id, meeting);
      }
      await deliver(item.turns.at(-1)!, `${item.id}-${item.turns.length - 1}`);
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    run.ms = Date.now() - started;
    await engine.endSession(item.id);
  }
  return run;
}

/** Checks every case gets: no write it did not ask for, an answer, and a short spoken answer with no reasoning in it. */
export function commonChecks(item: EvalCase): Check[] {
  const allowed = item.writes ?? {};
  const voice = (item.mode ?? 'voice') === 'voice';
  return [
    { dimension: 'no_fabrication', name: 'no write beyond what was asked', pass: run => {
      const counts = new Map<string, number>();
      for (const call of run.calls.filter(isWrite)) counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
      return [...counts].every(([method, count]) => count <= (allowed[method as WriteMethod] ?? 0));
    } },
    { dimension: 'clarity', name: 'answered', pass: run => !run.error && said(run).trim().length > 0 },
    ...(voice ? [
      { dimension: 'clarity' as const, name: 'spoken answer is short', pass: (run: CaseRun) => run.turns.every(turn =>
        turn.spoken.join(' ').split(/\s+/).filter(Boolean).length <= MAX_SPOKEN_WORDS) },
      { dimension: 'clarity' as const, name: 'no reasoning aloud', pass: (run: CaseRun) => run.turns.every(turn =>
        !turn.spoken.some(line => REASONING_ALOUD.test(line))) },
    ] : []),
  ];
}

export interface CheckResult { dimension: Dimension; name: string; pass: boolean }
export interface CaseScore { id: string; group: string; passed: boolean; checks: CheckResult[]; ms: number; error?: string }

export function scoreCase(item: EvalCase, run: CaseRun): CaseScore {
  const checks = [...item.checks, ...commonChecks(item)].map(check => {
    let pass = false;
    try { pass = check.pass(run); } catch { /* A check that cannot read the run fails. */ }
    return { dimension: check.dimension, name: check.name, pass };
  });
  return { id: item.id, group: item.group, passed: checks.every(check => check.pass), checks, ms: run.ms,
    ...(run.error ? { error: run.error } : {}) };
}

export interface Summary {
  cases: number;
  passed: number;
  /** Share of checks passed per dimension, 0..1. */
  dimensions: Record<Dimension, { passed: number; total: number; score: number }>;
}

export function summarize(scores: CaseScore[]): Summary {
  const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => {
    const checks = scores.flatMap(score => score.checks).filter(check => check.dimension === dimension);
    const passed = checks.filter(check => check.pass).length;
    return [dimension, { passed, total: checks.length, score: checks.length ? passed / checks.length : 1 }];
  })) as Summary['dimensions'];
  return { cases: scores.length, passed: scores.filter(score => score.passed).length, dimensions };
}
