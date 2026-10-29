/**
 * Voice lab output: report.json (everything), report.md (readable summary), report.html (timing chart)
 * and one stereo WAV per scenario (left: the room's microphones, right: Nogita) to listen back.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wav } from './audio.ts';
import type { TurnRecord } from './conversation.ts';
import { stats, type Stats, type TurnScore } from './score.ts';
import type { Scenario } from './scenarios.ts';

export interface ScenarioResult {
  scenario: Scenario;
  turns: Array<{ record: TurnRecord; score: TurnScore }>;
  room: Float32Array;
  nogita: Float32Array;
  errors: string[];
}

export interface RunSummary {
  startedAt: string;
  settings: Record<string, string>;
  responseGap: Stats;
  breakdown: { endpointing: Stats; router: Stats; thinking: Stats; voice: Stats };
  answerLength: Stats;
  bargeInStop: Stats;
  passed: number;
  total: number;
  addressHeard: { heard: number; total: number };
  meanWer?: number;
  judge?: { correct?: number; natural?: number; concise?: number };
}

const diff = (a?: number, b?: number) => a !== undefined && b !== undefined ? a - b : undefined;

export function summarize(results: ScenarioResult[], settings: Record<string, string>, startedAt: string): RunSummary {
  const turns = results.flatMap(result => result.turns);
  const answered = turns.filter(({ record }) => record.timing.firstAudio !== undefined);
  const t = answered.map(({ record }) => record.timing);
  const address = turns.filter(({ score }) => score.addressHeard !== undefined);
  const wers = turns.map(({ score }) => score.wer).filter((wer): wer is number => wer !== undefined);
  const judged = turns.map(({ score }) => score.judgement).filter(j => !!j);
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100 : undefined;
  return {
    startedAt, settings,
    responseGap: stats(t.map(timing => timing.firstAudio)),
    breakdown: {
      endpointing: stats(t.map(timing => timing.sttFinal)),
      router: stats(t.map(timing => diff(timing.utterance, timing.sttFinal))),
      thinking: stats(t.map(timing => diff(timing.firstSpeakCall, timing.utterance))),
      voice: stats(t.map(timing => diff(timing.firstAudio, timing.firstSpeakCall))),
    },
    answerLength: stats(t.map(timing => diff(timing.answerEnd, timing.firstAudio))),
    bargeInStop: stats(turns.map(({ record }) => record.timing.bargeInStop)),
    passed: turns.filter(({ score }) => score.passed).length, total: turns.length,
    addressHeard: { heard: address.filter(({ score }) => score.addressHeard).length, total: address.length },
    meanWer: mean(wers),
    ...(judged.length ? { judge: { correct: mean(judged.map(j => j!.correct)), natural: mean(judged.map(j => j!.natural)),
      concise: mean(judged.map(j => j!.concise)) } } : {}),
  };
}

const ms = (value?: number) => value === undefined ? '–' : `${(value / 1000).toFixed(2)} s`;
const statLine = (s: Stats) => s.count ? `p50 ${ms(s.p50)} · p90 ${ms(s.p90)} · max ${ms(s.max)} (n=${s.count})` : '–';

export function markdown(summary: RunSummary, results: ScenarioResult[]): string {
  const lines = [
    `# Nogita voice lab — ${summary.startedAt}`, '',
    Object.entries(summary.settings).map(([key, value]) => `${key}: \`${value}\``).join(' · '), '',
    '## Response time (end of question → first sound from Nogita)', '',
    `- **Response gap:** ${statLine(summary.responseGap)}`,
    `- Speech recognition endpointing: ${statLine(summary.breakdown.endpointing)}`,
    `- Router quiet window: ${statLine(summary.breakdown.router)}`,
    `- Thinking (engine + model to first sentence): ${statLine(summary.breakdown.thinking)}`,
    `- Voice (TTS + transport to first audio): ${statLine(summary.breakdown.voice)}`,
    `- Spoken answer length: ${statLine(summary.answerLength)}`,
    ...(summary.bargeInStop.count ? [`- Stop after being interrupted: ${statLine(summary.bargeInStop)}`] : []), '',
    '## Quality', '',
    `- Turns passed: **${summary.passed}/${summary.total}**`,
    `- Name recognized when addressed: ${summary.addressHeard.heard}/${summary.addressHeard.total}`,
    `- Mean word error rate of the transcript: ${summary.meanWer ?? '–'}`,
    ...(summary.judge ? [`- Judge (1-5): correct ${summary.judge.correct} · natural ${summary.judge.natural} · concise ${summary.judge.concise}`] : []),
    '',
  ];
  for (const result of results) {
    lines.push(`## ${result.scenario.title} (\`${result.scenario.name}\`, ${result.scenario.noise.kind} ${result.scenario.noise.kind === 'quiet' ? '' : `${result.scenario.noise.snrDb} dB`})`, '');
    for (const error of result.errors) lines.push(`> error: ${error}`, '');
    lines.push('| # | Said | Heard | Gap | Result | Nogita said |', '| --- | --- | --- | --- | --- | --- |');
    for (const { record, score } of result.turns) {
      const failed = score.checks.filter(check => !check.ok).map(check => check.detail ? `${check.name} (${check.detail})` : check.name);
      const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${record.index + 1} | ${cell(record.script)} | ${cell(record.heard ?? '—')} | ${ms(record.timing.firstAudio)} | ${score.passed ? '✅' : `❌ ${cell(failed.join('; '))}`} | ${cell(record.spoken.join(' ').slice(0, 300) || (record.chat[0] ? `(chat) ${record.chat[0].slice(0, 200)}` : '—'))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function html(summary: RunSummary, results: ScenarioResult[]): string {
  const answered = results.flatMap(result => result.turns.map(turn => ({ ...turn, scenario: result.scenario })));
  const scaleMax = Math.max(4_000, ...answered.map(({ record }) => record.timing.firstAudio ?? record.timing.utterance ?? 0));
  const pct = (value: number) => `${Math.max(0, Math.min(100, value / scaleMax * 100)).toFixed(2)}%`;
  const rows = answered.map(({ record, score, scenario }) => {
    const t = record.timing;
    const segments: Array<[string, number | undefined, number | undefined]> = [
      ['stt', 0, t.sttFinal], ['router', t.sttFinal, t.utterance], ['think', t.utterance, t.firstSpeakCall], ['voice', t.firstSpeakCall, t.firstAudio],
    ];
    const bars = segments.filter(([, from, to]) => from !== undefined && to !== undefined && to > from)
      .map(([name, from, to]) => `<span class="seg ${name}" style="left:${pct(from!)};width:${pct(to! - from!)}" title="${name}: ${to! - from!} ms"></span>`).join('');
    const failed = score.checks.filter(check => !check.ok).map(check => check.name).join(', ');
    return `<tr class="${score.passed ? 'ok' : 'bad'}"><td class="who">${escape(scenario.name)} #${record.index + 1}</td>
<td class="q"><div>${escape(record.script)}</div><div class="heard">heard: ${escape(record.heard ?? '—')}</div>
<div class="said">${escape(record.spoken.join(' ').slice(0, 280) || (record.chat[0] ?? '—'))}</div>${failed ? `<div class="fail">✗ ${escape(failed)}</div>` : ''}</td>
<td class="bar"><div class="track">${bars}</div></td><td class="num">${ms(t.firstAudio)}</td></tr>`;
  }).join('\n');
  const tile = (label: string, value: string) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nogita Voice Lab</title><style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--line:#e4e1da;--card:#fff;--stt:#5b8def;--router:#e0a43a;--think:#a46ee0;--voice:#3fae7a;--bad:#c4473a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171716;--fg:#ecebe7;--muted:#a19d95;--line:#2f2e2b;--card:#201f1d}}
:root[data-theme="dark"]{--bg:#171716;--fg:#ecebe7;--muted:#a19d95;--line:#2f2e2b;--card:#201f1d}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;padding:24px 16px}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.label{color:var(--muted);font-size:12px}.value{font-size:20px;font-weight:600}
.legend span{display:inline-flex;align-items:center;gap:6px;margin-right:14px;color:var(--muted);font-size:12px}.legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
table{width:100%;border-collapse:collapse;margin-top:10px}td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}
.who{color:var(--muted);white-space:nowrap;font-size:12px}.q{min-width:0}.heard{color:var(--muted);font-size:12px}.said{font-size:12px;margin-top:3px}.fail{color:var(--bad);font-size:12px}
.bar{width:38%}.track{position:relative;height:14px;background:var(--line);border-radius:4px;margin-top:4px}.seg{position:absolute;top:0;height:100%;border-radius:3px}
.seg.stt{background:var(--stt)}.seg.router{background:var(--router)}.seg.think{background:var(--think)}.seg.voice{background:var(--voice)}
.num{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}tr.bad .num{color:var(--bad)}
@media (max-width:700px){.bar{display:none}}
</style></head><body><main>
<h1>Nogita voice lab</h1><div class="sub">${escape(summary.startedAt)} · ${escape(Object.entries(summary.settings).map(([k, v]) => `${k} ${v}`).join(' · '))}</div>
<div class="tiles">${tile('Response gap p50', ms(summary.responseGap.p50))}${tile('Response gap p90', ms(summary.responseGap.p90))}
${tile('Turns passed', `${summary.passed}/${summary.total}`)}${tile('Name recognized', `${summary.addressHeard.heard}/${summary.addressHeard.total}`)}
${tile('Transcript WER', String(summary.meanWer ?? '–'))}${summary.judge ? tile('Judge correct/natural', `${summary.judge.correct} / ${summary.judge.natural}`) : ''}</div>
<div class="legend"><span><i style="background:var(--stt)"></i>speech recognition endpoint</span><span><i style="background:var(--router)"></i>router quiet window</span>
<span><i style="background:var(--think)"></i>thinking to first sentence</span><span><i style="background:var(--voice)"></i>voice synthesis to first sound</span></div>
<table>${rows}</table></main></body></html>`;
}

export async function writeReport(dir: string, summary: RunSummary, results: ScenarioResult[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), markdown(summary, results));
  await writeFile(join(dir, 'report.html'), html(summary, results));
  await writeFile(join(dir, 'report.json'), JSON.stringify({ summary, scenarios: results.map(result => ({
    name: result.scenario.name, errors: result.errors,
    turns: result.turns.map(({ record, score }) => ({ ...record, turn: undefined, expect: record.turn.expect, score,
      events: record.events.map(event => ({ ...event, t: Math.round(event.t - record.timing.speechEnd) })),
      timing: { ...record.timing, speechStart: undefined, speechEnd: undefined,
        speechMs: Math.round(record.timing.speechEnd - record.timing.speechStart) } })),
  })) }, null, 2));
  for (const result of results) await writeFile(join(dir, `${result.scenario.name}.wav`), wav([result.room, result.nogita]));
}
