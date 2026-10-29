/**
 * Release report from real-meeting turn logs (src/app/turn-log.ts): latency, missed questions, unnamed activations,
 * interruptions, completion, stale speech after a stop, and stuck screens, against the targets in docs/voice-benchmark.md.
 *
 *   node --experimental-transform-types tools/turn-report.ts [.nogita-state/turns/*.jsonl ...] [--out report.md]
 *
 * With no files it reads every log in .nogita-state/turns. Numbers come only from what the logs recorded; anything that
 * needs a person's judgement (was an unnamed activation wrong?) is listed for review, not counted as a failure.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Line = Record<string, unknown> & { at: number; type: string };

export interface SessionReport {
  name: string;
  minutes: number;
  questions: number;
  finals: Record<string, number>;
  firstAudioMs: number[];
  interruptMs: number[];
  commandStops: number;
  missed: Array<{ at: number; why: string; text?: string }>;
  unnamedActivations: Array<{ at: number; result: string; text?: string }>;
  staleSpeech: number;
  stuckScreens: Array<{ state: string; ms: number }>;
  lowConfidence: number;
  heard: number;
  longAnswers: number;
}

const OPEN = new Set(['speculative', 'working', 'answering', 'interrupted']);
/** Statuses the person chose (or that replaced a question): not counted against completion. */
const WITHDRAWN = new Set(['cancelled', 'stopped', 'superseded', 'rolled_back', 'duplicate']);

export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

export function analyse(name: string, lines: readonly Line[]): SessionReport {
  const events = [...lines].sort((a, b) => a.at - b.at);
  const report: SessionReport = { name, minutes: 0, questions: 0, finals: {}, firstAudioMs: [], interruptMs: [], commandStops: 0,
    missed: [], unnamedActivations: [], staleSpeech: 0, stuckScreens: [], lowConfidence: 0, heard: 0, longAnswers: 0 };
  if (events.length) report.minutes = Math.round((events.at(-1)!.at - events[0]!.at) / 600) / 100;
  const questions = new Map<number, { opened: number; speaker: string; final?: string; firstSpeechAt?: number; firstAudio?: number }>();
  const heardBy = new Map<string, number[]>();
  let speakingQuestion: number | undefined;
  let audioStartAt: number | undefined;
  let ui: { state: string; since: number } | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'heard': {
        report.heard++;
        if (typeof event.confidence === 'number' && event.confidence < 0.7) report.lowConfidence++;
        if (event.addressed && event.verified) {
          const list = heardBy.get(String(event.speaker)) ?? [];
          list.push(event.at);
          heardBy.set(String(event.speaker), list);
        }
        break;
      }
      case 'question': {
        const id = Number(event.id);
        let q = questions.get(id);
        if (!q) { q = { opened: event.at, speaker: String(event.speaker) }; questions.set(id, q); }
        const status = String(event.status);
        if (!OPEN.has(status) && !q.final) {
          q.final = status;
          if (status === 'failed' || (status === 'chat_only' && /no opening/.test(String(event.detail ?? '')))) {
            report.missed.push({ at: event.at, why: `question ended ${status}${event.detail ? ` (${String(event.detail)})` : ''}`,
              ...(event.request ? { text: String(event.request) } : {}) });
          }
        }
        break;
      }
      case 'speech': {
        const id = Number(event.id);
        const q = questions.get(id);
        if (event.phase === 'start') {
          speakingQuestion = id;
          if (q?.final && WITHDRAWN.has(q.final)) report.staleSpeech++;
          if (q && q.firstSpeechAt === undefined) q.firstSpeechAt = event.at;
        } else if (speakingQuestion === id) speakingQuestion = undefined;
        break;
      }
      case 'audio': {
        if (event.phase === 'start') {
          audioStartAt = event.at;
          const q = speakingQuestion === undefined ? undefined : questions.get(speakingQuestion);
          if (q && q.firstAudio === undefined) {
            q.firstAudio = event.at;
            // From the end of the person's turn (the transcript arrived) to the first sound of her voice.
            const asked = (heardBy.get(q.speaker) ?? []).filter(at => at <= q.opened && q.opened - at < 15_000).at(-1) ?? q.opened;
            report.firstAudioMs.push(event.at - asked);
          }
        } else if (audioStartAt !== undefined) {
          if (event.outcome === 'done' && Number(event.playedMs ?? 0) > 15_000) report.longAnswers++;
          audioStartAt = undefined;
        }
        break;
      }
      case 'interrupt':
        if (event.cause === 'voice' && typeof event.latencyMs === 'number') report.interruptMs.push(event.latencyMs);
        else report.commandStops++;
        break;
      case 'turn':
        if (event.addressed && event.result === 'ignored' && Number(event.words) > 2) {
          report.missed.push({ at: event.at, why: 'addressed by name but ignored', ...(event.text ? { text: String(event.text) } : {}) });
        }
        if (!event.addressed && (event.result === 'answered' || event.result === 'completed')) {
          report.unnamedActivations.push({ at: event.at, result: String(event.result), ...(event.text ? { text: String(event.text) } : {}) });
        }
        break;
      case 'ui': {
        const state = String(event.state);
        if (ui && ui.state !== state) {
          const ms = event.at - ui.since;
          if ((ui.state === 'thinking' && ms > 60_000) || (ui.state === 'speaking' && ms > 30_000) || (ui.state === 'listening' && ms > 20_000)) {
            report.stuckScreens.push({ state: ui.state, ms });
          }
        }
        if (!ui || ui.state !== state) ui = { state, since: event.at };
        break;
      }
      case 'stale_question':
        report.stuckScreens.push({ state: 'thinking (question dropped by watchdog)', ms: 120_000 });
        break;
    }
  }
  if (ui && events.length && !['idle', 'leaving'].includes(ui.state) && events.at(-1)!.at - ui.since > 60_000) {
    report.stuckScreens.push({ state: `${ui.state} at end of log`, ms: events.at(-1)!.at - ui.since });
  }
  for (const q of questions.values()) {
    report.questions++;
    const final = q.final ?? 'never finished';
    report.finals[final] = (report.finals[final] ?? 0) + 1;
    if (!q.final) report.missed.push({ at: q.opened, why: 'question never reached a final status' });
  }
  return report;
}

const fmt = (ms?: number) => ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(2)} s`;
const mark = (ok?: boolean) => ok === undefined ? 'no data' : ok ? 'meets' : '**misses**';

export function render(reports: readonly SessionReport[]): string {
  const all = (pick: (r: SessionReport) => number[]) => reports.flatMap(pick);
  const firstAudio = all(r => r.firstAudioMs);
  const interrupts = all(r => r.interruptMs);
  const finals: Record<string, number> = {};
  for (const r of reports) for (const [k, v] of Object.entries(r.finals)) finals[k] = (finals[k] ?? 0) + v;
  const counted = Object.entries(finals).filter(([k]) => !WITHDRAWN.has(k)).reduce((sum, [, v]) => sum + v, 0);
  const completion = counted ? (finals.answered ?? 0) / counted : undefined;
  const missed = reports.flatMap(r => r.missed);
  const stale = reports.reduce((sum, r) => sum + r.staleSpeech, 0);
  const stuck = reports.flatMap(r => r.stuckScreens);
  const p50 = percentile(firstAudio, 50); const p95 = percentile(firstAudio, 95); const i95 = percentile(interrupts, 95);
  const lines = [
    '# Nogita release report (from real-meeting turn logs)', '',
    `Sessions: ${reports.length} · minutes: ${reports.reduce((s, r) => s + r.minutes, 0).toFixed(1)} · questions: ${counted + Object.entries(finals).filter(([k]) => WITHDRAWN.has(k)).reduce((s, [, v]) => s + v, 0)}`, '',
    '| Measure | Value | Target | Result |', '|---|---|---|---|',
    `| First audible response p50 (end of turn to her first sound) | ${fmt(p50)} (n=${firstAudio.length}) | ≤ 1.0 s | ${mark(p50 === undefined ? undefined : p50 <= 1_000)} |`,
    `| First audible response p95 | ${fmt(p95)} | ≤ 2.0 s | ${mark(p95 === undefined ? undefined : p95 <= 2_000)} |`,
    `| Interruption to silence p95 (voice onset to stop) | ${fmt(i95)} (n=${interrupts.length}) | ≤ 0.3 s | ${mark(i95 === undefined ? undefined : i95 <= 300)} |`,
    `| Missed or silently lost questions | ${missed.length} | 0 | ${mark(missed.length === 0)} |`,
    `| Speech for a stopped/cancelled question | ${stale} | 0 | ${mark(stale === 0)} |`,
    `| Stuck screen states | ${stuck.length} | 0 | ${mark(stuck.length === 0)} |`,
    `| Completion rate (answered / questions not withdrawn) | ${completion === undefined ? 'n/a' : `${Math.round(completion * 100)}%`} | ≥ 95% | ${mark(completion === undefined ? undefined : completion >= 0.95)} |`,
    `| Answers longer than 15 s of speech | ${reports.reduce((s, r) => s + r.longAnswers, 0)} | 0 | ${mark(reports.every(r => r.longAnswers === 0))} |`,
    `| Unnamed activations (follow-ups / one-to-one) | ${reports.reduce((s, r) => s + r.unnamedActivations.length, 0)} | review each | needs a person |`,
    `| Low-confidence turns (< 0.7) | ${reports.reduce((s, r) => s + r.lowConfidence, 0)} of ${reports.reduce((s, r) => s + r.heard, 0)} | — | — |`,
    '', `Final statuses: ${Object.entries(finals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`, '',
  ];
  if (missed.length) {
    lines.push('## Missed or lost', '');
    for (const r of reports) for (const m of r.missed) lines.push(`- ${r.name} @${new Date(m.at).toISOString()}: ${m.why}${m.text ? ` — "${m.text}"` : ''}`);
    lines.push('');
  }
  const unnamed = reports.flatMap(r => r.unnamedActivations.map(a => ({ ...a, name: r.name })));
  if (unnamed.length) {
    lines.push('## Unnamed activations to review (was she being talked to?)', '');
    for (const a of unnamed) lines.push(`- ${a.name} @${new Date(a.at).toISOString()}: ${a.result}${a.text ? ` — "${a.text}"` : ' (words not logged; use NOGITA_TURN_LOG=full in test meetings)'}`);
    lines.push('');
  }
  if (stuck.length) {
    lines.push('## Stuck screen states', '');
    for (const s of stuck) lines.push(`- ${s.state} for ${fmt(s.ms)}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : undefined;
  let files = args;
  if (!files.length) {
    const directory = join(process.env.NOGITA_STATE_DIR ?? '.nogita-state', 'turns');
    files = (await readdir(directory).catch(() => [] as string[])).filter(f => f.endsWith('.jsonl')).map(f => join(directory, f));
  }
  const reports: SessionReport[] = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Line]; } catch { return []; }
    });
    reports.push(analyse(file.split(/[\\/]/).at(-1)!.replace(/\.jsonl$/, ''), lines));
  }
  const text = reports.length ? render(reports) : 'No turn logs found. Run a meeting with the server (NOGITA_TURN_LOG is on by default).\n';
  if (out) await writeFile(out, text); else process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('turn-report.ts')) {
  void main();
}
