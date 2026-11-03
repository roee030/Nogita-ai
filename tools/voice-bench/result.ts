/**
 * The normalized benchmark result (docs/VOICE_ENGINE_PLAN.md): one shape for every voice engine, and one way of
 * measuring turn-taking from a played scenario's event log, so Gemini and the cascaded v2 pipeline are counted by the
 * same code. P7-1 keeps this file; the spike that feeds it is thrown away.
 *
 * Definitions (per scripted turn i, between its start and the next turn's start):
 * - answered: one of her bursts of audio starts in that window (or overlaps it, for a barge-in).
 * - responsesToNonAddressed: a turn expected to get silence got her voice.
 * - prematureResponses: she started while that turn's speaker was still inside the turn (including its pauses).
 * - talkOver: she started while anyone's speech was playing.
 * - lostQuestions: a turn expected to get speech got none.
 * - interruptionMs: from a barge-in's start to her audio stopping (a barge-in she did not stop for counts as 5000 ms).
 * - firstAudibleMs: from the end of a turn expected to get speech to her first audio after it.
 * - backchannels kept / falsePauses: whether a "mm-hm" or a cough stopped her within 1.5 s.
 */
import type { LabEvent } from '../voice-lab/rig.ts';
import type { Scenario } from '../voice-lab/scenarios.ts';

export interface Distribution { n: number; p50: number | null; p95: number | null }

export interface RunMetrics {
  scenario: string;
  turns: number;
  questions: number;
  responsesToNonAddressed: number;
  prematureResponses: number;
  talkOver: number;
  lostQuestions: number;
  interruptionMs: number[];
  firstAudibleMs: number[];
  backchannels: { kept: number; total: number };
  falsePauses: { paused: number; total: number };
}

export interface VoiceBenchResult {
  engine: string;
  commit: string;
  date: string;
  /** Scenario name -> repetitions run. */
  runs: Record<string, number>;
  turns: number;
  questions: number;
  /** Null: not measured by this run (the spike has no tools, identity or writes). */
  wrongSpeakerAttributions: number | null;
  unauthorizedWrites: number | null;
  ungroundedSpokenClaims: number | null;
  taskSuccessRate: number | null;
  responsesToNonAddressed: number;
  prematureResponses: number;
  talkOver: number;
  lostQuestions: number;
  interruptionMs: Distribution;
  firstAudibleMs: Distribution;
  backchannels: { kept: number; total: number };
  falsePauses: { paused: number; total: number };
  /** Mean human rating, 1-5, filled in by Roee at gate A. */
  hebrewQuality: { understanding: number; naturalness: number; samples: number } | null;
  usdPerMeetingHour: { estimated: number | null; actual: number | null };
  notes: string[];
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
export const distribution = (values: readonly number[]): Distribution =>
  ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) });

const NO_STOP_MS = 5_000;
const STOP_WINDOW_MS = 1_500;

/** Her bursts of audio, as [start, stop] pairs. */
function bursts(events: readonly LabEvent[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | undefined;
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.type === 'audio_start' && start === undefined) start = event.t;
    if (event.type === 'audio_stop' && start !== undefined) { out.push([start, Math.max(start, event.t)]); start = undefined; }
  }
  if (start !== undefined) out.push([start, Infinity]);
  return out;
}

/** Each scripted turn's [start, end], from the speech events in the order the turns were said. */
function turnMarks(events: readonly LabEvent[], count: number): Array<{ start: number; end: number }> {
  const starts = events.filter(event => event.type === 'speech_start').sort((a, b) => a.t - b.t);
  const ends = events.filter(event => event.type === 'speech_end').sort((a, b) => a.t - b.t);
  const used = new Set<LabEvent>();
  return starts.slice(0, count).map(start => {
    const end = ends.find(event => !used.has(event) && event.participant === start.participant && event.t >= start.t);
    if (end) used.add(end);
    return { start: start.t, end: end?.t ?? start.t };
  });
}

export function measureRun(scenario: Scenario, events: readonly LabEvent[]): RunMetrics {
  const marks = turnMarks(events, scenario.turns.length);
  const audio = bursts(events);
  // A barge-in, a backchannel or a cough is said over her; resuming after one is not starting over someone.
  const speaking = (t: number) => marks.some((mark, i) => !scenario.turns[i]?.bargeIn && !scenario.turns[i]?.perturbation &&
    t > mark.start + 50 && t < mark.end - 50);
  const metrics: RunMetrics = { scenario: scenario.name, turns: marks.length, questions: 0, responsesToNonAddressed: 0,
    prematureResponses: 0, talkOver: 0, lostQuestions: 0, interruptionMs: [], firstAudibleMs: [],
    backchannels: { kept: 0, total: 0 }, falsePauses: { paused: 0, total: 0 } };
  for (const [start] of audio) if (speaking(start)) metrics.talkOver++;
  scenario.turns.forEach((turn, i) => {
    const mark = marks[i];
    if (!mark) return;
    const nextStart = marks[i + 1]?.start ?? Infinity;
    const startsIn = audio.filter(([start]) => start >= mark.start && start < nextStart);
    const playingAt = (t: number) => audio.find(([start, stop]) => start <= t && stop > t);
    if (turn.bargeIn || turn.perturbation) {
      const playing = playingAt(mark.start);
      if (!playing) return;
      const stoppedAfter = playing[1] - mark.start;
      if (turn.perturbation) {
        metrics.falsePauses.total++;
        if (stoppedAfter < STOP_WINDOW_MS) metrics.falsePauses.paused++;
      } else if (turn.bargeIn?.kind === 'backchannel') {
        // Kept: still (or again) talking 1.5 s after the "mm-hm"; a short pause and resume is not a stop.
        metrics.backchannels.total++;
        if (playingAt(mark.start + STOP_WINDOW_MS)) metrics.backchannels.kept++;
      } else {
        metrics.interruptionMs.push(Math.min(NO_STOP_MS, Math.round(stoppedAfter)));
      }
      return;
    }
    // Her own bursts that began while this turn was being said, pauses included.
    const during = startsIn.filter(([start]) => start < mark.end - 50);
    if (during.length) metrics.prematureResponses++;
    if (turn.expect.respond === 'silent' && startsIn.length) metrics.responsesToNonAddressed++;
    if (turn.expect.respond === 'speak') {
      metrics.questions++;
      const after = startsIn.find(([start]) => start >= mark.end - 50);
      if (!startsIn.length) metrics.lostQuestions++;
      else if (after) metrics.firstAudibleMs.push(Math.round(after[0] - mark.end));
    }
  });
  return metrics;
}

export function combine(engine: string, commit: string, runs: readonly RunMetrics[], extra: Partial<VoiceBenchResult> = {}): VoiceBenchResult {
  const sum = (pick: (run: RunMetrics) => number) => runs.reduce((total, run) => total + pick(run), 0);
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.scenario] = (counts[run.scenario] ?? 0) + 1;
  return {
    engine, commit, date: new Date().toISOString().slice(0, 10), runs: counts, turns: sum(run => run.turns), questions: sum(run => run.questions),
    wrongSpeakerAttributions: null, unauthorizedWrites: null, ungroundedSpokenClaims: null, taskSuccessRate: null,
    responsesToNonAddressed: sum(run => run.responsesToNonAddressed), prematureResponses: sum(run => run.prematureResponses),
    talkOver: sum(run => run.talkOver), lostQuestions: sum(run => run.lostQuestions),
    interruptionMs: distribution(runs.flatMap(run => run.interruptionMs)), firstAudibleMs: distribution(runs.flatMap(run => run.firstAudibleMs)),
    backchannels: { kept: sum(run => run.backchannels.kept), total: sum(run => run.backchannels.total) },
    falsePauses: { paused: sum(run => run.falsePauses.paused), total: sum(run => run.falsePauses.total) },
    hebrewQuality: null, usdPerMeetingHour: { estimated: null, actual: null }, notes: [], ...extra,
  };
}

export interface GateLine { metric: string; value: string; threshold: string; pass: boolean | null }

/** Gate A (docs/VOICE_ENGINE_PLAN.md), set before the run. `null`: needs a human (Hebrew) or a number not measured yet. */
export function gateA(candidate: VoiceBenchResult, baseline: VoiceBenchResult): GateLine[] {
  const ip95 = candidate.interruptionMs.p95, bp95 = baseline.interruptionMs.p95;
  const usd = candidate.usdPerMeetingHour.estimated, baseUsd = baseline.usdPerMeetingHour.estimated;
  const hebrew = candidate.hebrewQuality;
  return [
    { metric: 'responsesToNonAddressed', value: String(candidate.responsesToNonAddressed), threshold: '0', pass: candidate.responsesToNonAddressed === 0 },
    { metric: 'prematureResponses', value: String(candidate.prematureResponses), threshold: '0', pass: candidate.prematureResponses === 0 },
    { metric: 'talkOver', value: String(candidate.talkOver), threshold: '0', pass: candidate.talkOver === 0 },
    { metric: 'interruptionMs p95', value: `${ip95 ?? '-'} ms (v2 ${bp95 ?? '-'} ms)`, threshold: '≤ 500 ms and ≤ v2 + 100 ms',
      pass: ip95 === null ? null : ip95 <= 500 && (bp95 === null || ip95 <= bp95 + 100) },
    { metric: 'lostQuestions', value: `${candidate.lostQuestions} (v2 ${baseline.lostQuestions})`, threshold: '≤ v2', pass: candidate.lostQuestions <= baseline.lostQuestions },
    { metric: 'firstAudibleMs p50', value: `${candidate.firstAudibleMs.p50 ?? '-'} ms`, threshold: '≤ 2500 ms',
      pass: candidate.firstAudibleMs.p50 === null ? null : candidate.firstAudibleMs.p50 <= 2500 },
    { metric: 'hebrewQuality', value: hebrew ? `${hebrew.understanding} / ${hebrew.naturalness} (${hebrew.samples})` : 'Roee rates',
      threshold: '≥ 4 / ≥ 4, 10 samples', pass: hebrew ? hebrew.understanding >= 4 && hebrew.naturalness >= 4 && hebrew.samples >= 10 : null },
    { metric: 'usdPerMeetingHour', value: usd === null ? '-' : `$${usd.toFixed(2)} (v2 ${baseUsd === null ? '-' : `$${baseUsd.toFixed(2)}`})`,
      threshold: '≤ 1.5 × v2, never > $3', pass: usd === null ? null : usd <= 3 && (baseUsd === null ? false : usd <= 1.5 * baseUsd) },
  ];
}
