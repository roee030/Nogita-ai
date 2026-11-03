/**
 * P7-1: the gate A numbers. Reads the Gemini spike's runs and the frozen v2 voice-lab reports, measures both with the
 * same voice-bench code, prices both per meeting hour, and writes docs/voice-benchmarks/*.json plus the gate table.
 *
 *   node --experimental-transform-types tools/gemini-spike/report.ts --gemini .voice-lab/gemini-spike/gate-a \
 *        --v2 .voice-lab/reports/p7-v2-r1,...  --commit <sha>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SessionUsageRegistry } from '../../src/app/session-usage.ts';
import { SCENARIOS } from '../voice-lab/scenarios.ts';
import { combine, gateA, measureRun, type RunMetrics, type VoiceBenchResult } from '../voice-bench/result.ts';
import { HEBREW_SCENARIOS } from './hebrew.ts';

const { values } = parseArgs({ options: { gemini: { type: 'string' }, v2: { type: 'string' }, commit: { type: 'string', default: '-' },
  out: { type: 'string', default: 'docs/voice-benchmarks' }, date: { type: 'string', default: new Date().toISOString().slice(0, 10) } } });

const ATTENDEE_USD_PER_HOUR = 0.5;
const DEEPGRAM_STT_USD_PER_MINUTE = 0.0058;

/** The v2 baseline: each scenario run priced exactly as /api/sessions/:id/usage prices a session. */
function v2Result(dirs: string[]): { result: VoiceBenchResult; hours: number; usd: number } {
  const runs: RunMetrics[] = [];
  let usd = 0, hours = 0;
  for (const dir of dirs) {
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { scenarios: Array<{ name: string; events: any[] }> };
    for (const scenario of report.scenarios) {
      const definition = SCENARIOS.find(s => s.name === scenario.name)!;
      runs.push(measureRun(definition, scenario.events));
      const usage = scenario.events.find(event => event.type === 'usage');
      if (!usage) continue;
      const used = JSON.parse(usage.detail) as { sttBytes: number; ttsCharacters: number; aiUsd: number; durationMs: number };
      let clock = 0;
      const registry = new SessionUsageRegistry(ATTENDEE_USD_PER_HOUR, () => clock);
      registry.start('s', 'attendee', true);
      registry.recordDeepgramSttBytes('s', used.sttBytes);
      if (used.ttsCharacters > 0) registry.recordDeepgramTtsCharacters('s', used.ttsCharacters);
      clock = used.durationMs;
      registry.end('s');
      const priced = registry.report('s', { model: 'agent', modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: used.aiUsd })!;
      usd += priced.totalEstimatedUsd;
      hours += used.durationMs / 3_600_000;
    }
  }
  const perHour = hours ? usd / hours : null;
  return { result: combine('cascaded-v2', values.commit!, runs, { usdPerMeetingHour: { estimated: perHour, actual: null },
    notes: ['Priced with SessionUsageRegistry (the code behind /api/sessions/:id/usage): Attendee, Deepgram STT and TTS, Anthropic.'] }), hours, usd };
}

function geminiResults(dir: string): { english: VoiceBenchResult; hebrew: VoiceBenchResult; hours: number; usd: number } {
  const hebrewNames = new Set(HEBREW_SCENARIOS.map(s => s.name));
  const english: RunMetrics[] = [], hebrew: RunMetrics[] = [];
  let usd = 0, hours = 0, micHours = 0;
  for (const file of readdirSync(dir).filter(name => /-r\d+\.json$/.test(name))) {
    const run = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { scenario: string; usd: number; durationMs: number; events: any[] };
    const definition = [...SCENARIOS, ...HEBREW_SCENARIOS].find(s => s.name === run.scenario)!;
    (hebrewNames.has(run.scenario) ? hebrew : english).push(measureRun(definition, run.events));
    usd += run.usd;
    hours += run.durationMs / 3_600_000;
    // Production keeps Deepgram per participant for identity, and Attendee for the meeting: priced the same as v2.
    micHours += definition.participants.filter(p => !p.sharesMicWith).length * run.durationMs / 3_600_000;
  }
  const total = usd + hours * ATTENDEE_USD_PER_HOUR + micHours * 60 * DEEPGRAM_STT_USD_PER_MINUTE;
  const perHour = hours ? total / hours : null;
  const note = 'Gemini priced from token counts at third-party list prices (audio in $3, out $12, text in $0.75 per 1M; not confirmed on Google\'s page), plus Attendee and Deepgram STT per participant for identity, as production would keep them. No tools ran, so Claude\'s cost for answers is not included.';
  return {
    english: combine('gemini-live', values.commit!, english, { usdPerMeetingHour: { estimated: perHour, actual: null }, notes: [note] }),
    hebrew: combine('gemini-live-hebrew', values.commit!, hebrew, { usdPerMeetingHour: { estimated: perHour, actual: null }, notes: [note] }),
    hours, usd: total,
  };
}

const v2 = v2Result(values.v2!.split(',').filter(dir => existsSync(join(dir, 'report.json'))));
const gemini = geminiResults(values.gemini!);
writeFileSync(join(values.out!, 'v2-baseline.json'), `${JSON.stringify(v2.result, null, 2)}\n`);
writeFileSync(join(values.out!, `gemini-spike-${values.date}.json`), `${JSON.stringify({ english: gemini.english, hebrew: gemini.hebrew }, null, 2)}\n`);

const row = (name: string, a: unknown, b: unknown) => `| ${name} | ${a} | ${b} |`;
const r = (x: VoiceBenchResult) => x;
console.log(`v2: ${v2.result.turns} turns, ${v2.hours.toFixed(2)} h, $${v2.usd.toFixed(2)}; Gemini: ${gemini.english.turns + gemini.hebrew.turns} turns, ${gemini.hours.toFixed(2)} h, $${gemini.usd.toFixed(2)}\n`);
console.log('| Metric | Gemini (English) | v2 |\n|---|---|---|');
for (const [name, pick] of [
  ['Questions (lost)', (x: VoiceBenchResult) => `${x.questions} (${x.lostQuestions})`],
  ['Answered when not addressed', (x: VoiceBenchResult) => x.responsesToNonAddressed],
  ['Started inside a turn (premature)', (x: VoiceBenchResult) => x.prematureResponses],
  ['Started while someone spoke', (x: VoiceBenchResult) => x.talkOver],
  ['Stop after interruption p50 / p95 (n)', (x: VoiceBenchResult) => `${x.interruptionMs.p50} / ${x.interruptionMs.p95} ms (${x.interruptionMs.n})`],
  ['First sound p50 / p95 (n)', (x: VoiceBenchResult) => `${x.firstAudibleMs.p50} / ${x.firstAudibleMs.p95} ms (${x.firstAudibleMs.n})`],
  ['Backchannels kept', (x: VoiceBenchResult) => `${x.backchannels.kept}/${x.backchannels.total}`],
  ['Paused on a cough or laugh', (x: VoiceBenchResult) => `${x.falsePauses.paused}/${x.falsePauses.total}`],
  ['USD per meeting hour (est.)', (x: VoiceBenchResult) => x.usdPerMeetingHour.estimated === null ? '-' : `$${x.usdPerMeetingHour.estimated.toFixed(2)}`],
] as Array<[string, (x: VoiceBenchResult) => unknown]>) console.log(row(name, pick(r(gemini.english)), pick(v2.result)));
console.log(`\nHebrew (Gemini only): questions ${gemini.hebrew.questions}, lost ${gemini.hebrew.lostQuestions}, not addressed ${gemini.hebrew.responsesToNonAddressed}, ` +
  `premature ${gemini.hebrew.prematureResponses}, over ${gemini.hebrew.talkOver}, stop ${JSON.stringify(gemini.hebrew.interruptionMs)}, first ${JSON.stringify(gemini.hebrew.firstAudibleMs)}`);
console.log('\n| Gate A | Value | Threshold | Pass |\n|---|---|---|---|');
for (const line of gateA(gemini.english, v2.result)) console.log(`| ${line.metric} | ${line.value} | ${line.threshold} | ${line.pass === null ? 'Roee / not measured' : line.pass ? 'yes' : '**no**'} |`);
