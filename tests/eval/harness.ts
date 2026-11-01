/**
 * Runs an eval case through the real engine and agent loop (voice budgets, write checks, follow-ups) against the
 * in-memory world, and scores it. The model is whatever ChatModel is passed: the real one for `npm run eval`, a
 * scripted one in tests.
 *
 * Every tool result the model is given is recorded in an Evidence Ledger, as the agent loop records it, and every
 * checkable claim in what she said (a pull request, commit, task key, file or link) must rest on one of those sources.
 */
import { NogitaEngine } from '../../src/core/engine.ts';
import { AllowlistPolicy } from '../../src/core/policy.ts';
import { DemoBrain, DemoMeeting } from '../../src/adapters/demo.ts';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../../src/core/agent.ts';
import type { ActionReceipt, Capability, SpeakOptions } from '../../src/core/contracts.ts';
import { EvidenceLedger } from '../../src/core/evidence.ts';
import { DIMENSIONS, type CaseRun, type Check, type Dimension, type EvalCase, type TurnRecord, type WriteMethod, said } from './cases.ts';
import { NOW, SPEAKERS, TEAM, evalWorld, isWrite } from './world.ts';

/** Spoken words in one answer above which it is no longer short (the voice prompt asks for about 20). */
const MAX_SPOKEN_WORDS = 75;
// "I should" inside a question to them ("a different spelling I should try?") is not reasoning.
const REASONING_ALOUD = /\b(?:I should\b(?![^.!?]*\?)|I need to (?:check|look|find)|let me think|this is a question about|the user (?:is|wants|asked))\b/i;

class TracedModel implements ChatModel {
  readonly tools: string[] = [];
  readonly stops: string[] = [];
  readonly ledger = new EvidenceLedger();
  /** The text of every result recorded in the ledger. */
  readonly evidence: string[] = [];
  private readonly uses = new Map<string, { name: string; input: Record<string, unknown>; step: number }>();
  private readonly recorded = new Set<string>();
  private steps = 0;
  constructor(private readonly inner: ChatModel) {}
  get agentModel(): string { return this.inner.agentModel; }
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.record(request);
    const response = await this.inner.streamChat(request, onText);
    this.stops.push(response.stopReason);
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      this.tools.push(block.name);
      this.uses.set(block.id, { name: block.name, input: block.input, step: this.steps });
    }
    this.steps++;
    return response;
  }
  /** Results the model is given for the first time, recorded as the agent loop records them: a failed call is no
   *  source. The engine's quick search, prefetched into the request itself, is a source too. */
  private record(request: ChatModelRequest): void {
    for (const message of request.messages) {
      if (typeof message.content === 'string') {
        const prefetch = message.content.indexOf(PREFETCH);
        if (prefetch >= 0 && !this.recorded.has(message.content)) {
          this.recorded.add(message.content);
          this.add('search_code', {}, message.content.slice(prefetch), this.steps);
        }
        continue;
      }
      for (const block of message.content) {
        if (block.type !== 'tool_result' || this.recorded.has(block.tool_use_id)) continue;
        this.recorded.add(block.tool_use_id);
        const use = this.uses.get(block.tool_use_id);
        if (use && !block.is_error) this.add(use.name, use.input, block.content, use.step);
      }
    }
  }
  private add(tool: string, input: Record<string, unknown>, content: string, step: number): void {
    this.ledger.record(tool, input, content, step);
    this.evidence.push(content);
  }
}
const PREFETCH = 'Quick search results for this request';

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
    board: world.board, posted: world.chat.posted, sources: [], evidence: traced.evidence, ms: 0 };
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
    run.sources = traced.ledger.list();
    await engine.endSession(item.id);
  }
  return run;
}

/** A claim she made that a source can confirm: a pull request, commit, task key, file or link. */
export interface Claim { kind: 'pull_request' | 'commit' | 'issue' | 'file' | 'link'; value: string }

const LINK = /https?:\/\/[^\s<>"'()\]]+[^\s<>"'()\].,;:!?]/g;
const PR_MENTION = (number: string) => new RegExp(`(?:\\bpr|pull request|#)\\s*#?${number}\\b`, 'i');

/**
 * The claims in one turn, spoken and in chat. Receipt lines are the system's own, and a reference the person gave in
 * their own words is not hers to prove, so neither counts.
 */
export function claimsIn(turn: TurnRecord, asked: string, receipts: readonly ActionReceipt[]): Claim[] {
  const receiptUrls = receipts.map(receipt => receipt.url);
  const text = [...turn.spoken, ...turn.chat.filter(line => !receiptUrls.some(url => line.includes(url)))].join('\n');
  const askedLower = asked.toLowerCase();
  const claims: Claim[] = [];
  const add = (claim: Claim) => {
    if (!claims.some(known => known.kind === claim.kind && known.value === claim.value)) claims.push(claim);
  };
  for (const url of text.match(LINK) ?? []) if (!asked.includes(url)) add({ kind: 'link', value: url });
  const prose = text.replace(LINK, ' ');
  for (const match of prose.matchAll(/(?:\bpr|pull request|#)\s*#?(\d{1,5})\b/gi)) {
    if (!PR_MENTION(match[1]!).test(asked)) add({ kind: 'pull_request', value: match[1]! });
  }
  for (const match of prose.matchAll(/\b[A-Z][A-Z0-9_]+-\d+\b/g)) if (!asked.includes(match[0])) add({ kind: 'issue', value: match[0] });
  for (const match of prose.matchAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g)) {
    if (!askedLower.includes(match[0].slice(0, 7))) add({ kind: 'commit', value: match[0] });
  }
  for (const match of prose.matchAll(/(?<![\w.-])([\w-]+(?:\.[\w-]+)*\.(?:ts|js|json|md|ya?ml))\b/g)) {
    if (!askedLower.includes(match[1]!.toLowerCase())) add({ kind: 'file', value: match[1]! });
  }
  return claims;
}

/** Whether a source in the ledger confirms the claim: a result names the same pull request, commit, key, file or link. */
export function isBacked(claim: Claim, evidence: readonly string[]): boolean {
  const text = evidence.join('\n');
  switch (claim.kind) {
    case 'link': return text.includes(claim.value);
    case 'pull_request': return new RegExp(`/pull/${claim.value}\\b`).test(text) || PR_MENTION(claim.value).test(text);
    case 'issue': return new RegExp(`\\b${claim.value}\\b`).test(text);
    case 'commit': return text.toLowerCase().includes(claim.value.slice(0, 7).toLowerCase());
    case 'file': return text.toLowerCase().includes(claim.value.toLowerCase());
  }
}

/** The claims in every turn she answered, and those no source in the ledger backs. */
export function claimCoverage(item: EvalCase, run: CaseRun): { total: number; backed: number; unbacked: Claim[] } {
  const claims = run.turns.flatMap((turn, index) => turn.result === 'ignored' ? []
    : claimsIn(turn, item.turns.slice(0, index + 1).join('\n'), run.receipts));
  const unbacked = claims.filter(claim => !isBacked(claim, run.evidence));
  return { total: claims.length, backed: claims.length - unbacked.length, unbacked };
}

/** Checks every case gets: no write it did not ask for, an answer, every claim backed by a source in the ledger, and a
 *  short spoken answer with no reasoning in it. */
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
    { dimension: 'sources', name: 'every claim has a source in the ledger', pass: run => claimCoverage(item, run).unbacked.length === 0 },
    ...(voice ? [
      { dimension: 'clarity' as const, name: 'spoken answer is short', pass: (run: CaseRun) => run.turns.every(turn =>
        turn.spoken.join(' ').split(/\s+/).filter(Boolean).length <= MAX_SPOKEN_WORDS) },
      { dimension: 'clarity' as const, name: 'no reasoning aloud', pass: (run: CaseRun) => run.turns.every(turn =>
        !turn.spoken.some(line => REASONING_ALOUD.test(line))) },
    ] : []),
  ];
}

export interface CheckResult { dimension: Dimension; name: string; pass: boolean }
export interface CaseScore {
  id: string; group: string; passed: boolean; checks: CheckResult[]; ms: number; error?: string;
  /** The claims she made, how many a source in the ledger backs, and the ones none does. */
  claims?: { total: number; backed: number; unbacked: string[] };
}

export function scoreCase(item: EvalCase, run: CaseRun): CaseScore {
  const checks = [...item.checks, ...commonChecks(item)].map(check => {
    let pass = false;
    try { pass = check.pass(run); } catch { /* A check that cannot read the run fails. */ }
    return { dimension: check.dimension, name: check.name, pass };
  });
  const coverage = claimCoverage(item, run);
  return { id: item.id, group: item.group, passed: checks.every(check => check.pass), checks, ms: run.ms,
    claims: { total: coverage.total, backed: coverage.backed, unbacked: coverage.unbacked.map(claim => `${claim.kind} ${claim.value}`) },
    ...(run.error ? { error: run.error } : {}) };
}

export interface Summary {
  cases: number;
  passed: number;
  /** Share of checks passed per dimension, 0..1. */
  dimensions: Record<Dimension, { passed: number; total: number; score: number }>;
  /** Claims across all runs that a source in the ledger backs; phase 3's gate asks for 90%. 1 when nothing was claimed. */
  claims: { total: number; backed: number; share: number };
}

export function summarize(scores: CaseScore[]): Summary {
  const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => {
    const checks = scores.flatMap(score => score.checks).filter(check => check.dimension === dimension);
    const passed = checks.filter(check => check.pass).length;
    return [dimension, { passed, total: checks.length, score: checks.length ? passed / checks.length : 1 }];
  })) as Summary['dimensions'];
  const total = scores.reduce((sum, score) => sum + (score.claims?.total ?? 0), 0);
  const backed = scores.reduce((sum, score) => sum + (score.claims?.backed ?? 0), 0);
  return { cases: scores.length, passed: scores.filter(score => score.passed).length, dimensions,
    claims: { total, backed, share: total ? backed / total : 1 } };
}
