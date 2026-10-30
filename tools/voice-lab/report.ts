/**
 * Voice lab output: report.html (summary, timing chart and every conversation), transcript.md (the conversations),
 * report.md (summary table), report.json (everything) and one stereo WAV per scenario (left: the room's microphones, right: Nogita) to listen back.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wav } from './audio.ts';
import { FILLERS, type TurnRecord } from './conversation.ts';
import { stats, type Stats, type TurnScore } from './score.ts';
import type { Scenario } from './scenarios.ts';
import type { LabEvent } from './rig.ts';
import { conversationStats, questionLedger, type ConversationStats } from './conversation-metrics.ts';

export interface ScenarioResult {
  scenario: Scenario;
  turns: Array<{ record: TurnRecord; score: TurnScore }>;
  room: Float32Array;
  nogita: Float32Array;
  errors: string[];
  /** The scenario's whole event log (questions, speech marks, Nogita's audio). */
  events: LabEvent[];
}

export interface RunSummary {
  startedAt: string;
  settings: Record<string, string>;
  responseGap: Stats;
  /** First sound that is not a canned filler. */
  contentGap: Stats;
  /** The answer itself: her first words after the last lookup (time to meaningful speech). */
  meaningfulGap: Stats;
  conversation: ConversationStats;
  /** Turns whose expected lookups were made. */
  toolChecks: { ok: number; total: number };
  breakdown: { endpointing: Stats; router: Stats; thinking: Stats; voice: Stats };
  answerLength: Stats;
  bargeInStop: Stats;
  passed: number;
  total: number;
  addressHeard: { heard: number; total: number };
  /** Spoken answers with no machine tell (chatbot phrases, paths read aloud, talking about the asker...). */
  soundsHuman?: { ok: number; total: number };
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
    contentGap: stats(t.map(timing => timing.firstContentAudio)),
    meaningfulGap: stats(t.map(timing => timing.meaningfulAudio)),
    conversation: conversationStats(results.map(result => result.events)),
    toolChecks: (() => {
      const checks = turns.flatMap(({ score }) => score.checks.filter(check => /^looked up |at most once$/.test(check.name)));
      return { ok: checks.filter(check => check.ok).length, total: checks.length };
    })(),
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
    soundsHuman: (() => {
      const checks = turns.flatMap(({ score }) => score.checks.filter(check => check.name === 'sounds human'));
      return { ok: checks.filter(check => check.ok).length, total: checks.length };
    })(),
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
    `- **Until real content** (her own words, not a filler such as "One sec."): ${statLine(summary.contentGap)}`,
    `- **Until the answer itself** (first words after the last lookup): ${statLine(summary.meaningfulGap)}`,
    `- Speech recognition endpointing: ${statLine(summary.breakdown.endpointing)}`,
    `- Router quiet window: ${statLine(summary.breakdown.router)}`,
    `- Thinking (engine + model to first sentence): ${statLine(summary.breakdown.thinking)}`,
    `- Voice (TTS + transport to first audio): ${statLine(summary.breakdown.voice)}`,
    `- Spoken answer length: ${statLine(summary.answerLength)}`,
    ...(summary.bargeInStop.count ? [`- Stop after being interrupted: ${statLine(summary.bargeInStop)}`] : []), '',
    '## Quality', '',
    `- Turns passed: **${summary.passed}/${summary.total}**`,
    `- Name recognized when addressed: ${summary.addressHeard.heard}/${summary.addressHeard.total}`,
    ...(summary.soundsHuman ? [`- Sounded human (no machine tells): **${summary.soundsHuman.ok}/${summary.soundsHuman.total}** spoken answers`] : []),
    `- Mean word error rate of the transcript: ${summary.meanWer ?? '–'}`,
    ...(summary.judge ? [`- Judge (1-5): correct ${summary.judge.correct} · natural ${summary.judge.natural} · concise ${summary.judge.concise}`] : []),
    `- Lookups as expected: ${summary.toolChecks.ok}/${summary.toolChecks.total}`,
    '', '## Conversation management', '', ...conversationLines(summary.conversation), '',
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

function conversationLines(c: ConversationStats): string[] {
  return [
    `- Questions taken on: **${c.questions}** · answered aloud ${c.answered} · only in chat ${c.chatOnly} · cancelled by the asker ${c.cancelled} · ` +
      `stopped by the room ${c.stopped} · failed ${c.failed} · **lost (never answered) ${c.unresolved}**`,
    `- Question completion: **${c.completion === undefined ? '–' : `${Math.round(c.completion * 100)}%`}** (answered aloud / questions not withdrawn)`,
    `- Same question asked again while open: ${c.askedAgain} (no second lookup)`,
    `- Speaker went on after a pause, so she restarted with the whole question: ${c.restarted}`,
    `- Early starts (before the end of the turn was confirmed): ${c.earlyStarts} · used ${c.earlyAdopted} · rolled back ${c.earlyRolledBack}`,
    `- Answers cut off by a participant: ${c.cutOff} · finished afterwards ${c.resumed}`,
    `- Started speaking while someone was mid-sentence: **${c.spokeOverPeople}**`,
    `- Duplicate writes: ${c.duplicateWrites}`,
  ];
}

export interface TranscriptLine {
  /** Seconds after the end of the question; undefined for the question itself. */
  at?: number;
  kind: 'person' | 'heard' | 'bridge' | 'nogita' | 'cut' | 'tool' | 'chat' | 'hand' | 'task' | 'message' | 'question' | 'verdict' | 'judge';
  who?: string;
  text: string;
}

/**
 * The conversation as it happened, turn by turn: what each person said and what the recognizer heard, every
 * sentence Nogita spoke (filler or her own words) with its delay, every lookup, chat line and action, and the
 * verdict of each check in plain words.
 */
export function transcriptLines(result: ScenarioResult): TranscriptLine[][] {
  const names = new Map(result.scenario.participants.map(p => [p.id, p.name]));
  return result.turns.map(({ record, score }) => {
    const end = record.timing.speechEnd;
    const at = (t: number) => Math.round((t - end) / 100) / 10;
    const lines: TranscriptLine[] = [{ kind: 'person', who: names.get(record.turn.speaker) ?? record.turn.speaker, text: record.script }];
    if (record.heard !== record.script) lines.push({ kind: 'heard', text: record.heard ?? '(nothing reached Nogita)' });
    const cut = new Set(record.events.filter(e => e.type === 'speak_error' && /interrupt/i.test(e.detail ?? '')).map(e => e.text));
    const spoken = new Set(record.spoken);
    for (const event of record.events) {
      const text = event.text ?? '';
      if (event.type === 'speak_call' && event.t >= end) {
        lines.push({ at: at(event.t), kind: cut.has(text) ? 'cut' : FILLERS.has(text) ? 'bridge' : 'nogita', text });
      } else if (event.type === 'tool') lines.push({ at: at(event.t), kind: 'tool', text });
      else if (event.type === 'question' && event.detail && event.t >= record.timing.speechStart) {
        lines.push({ at: at(event.t), kind: 'question', text: `${event.detail}${/ (working|speculative)\b/.test(event.detail) ? ` — "${text}"` : ''}` });
      }
      else if (event.type === 'write') {
        lines.push({ at: at(event.t), kind: text.startsWith('task:') ? 'task' : 'message',
          text: `${text.replace(/^(?:task|message): /, '')}${event.detail ? ` [${event.detail}]` : ''}` });
      } else if (event.type === 'chat' && !spoken.has(text)) {
        lines.push({ at: at(event.t), kind: /has something to add/i.test(text) ? 'hand' : 'chat', text });
      }
    }
    const verdicts = score.checks.map(check => `${check.ok ? '✓' : '✗'} ${check.name}${check.detail && !check.ok ? ` (${check.detail})` : check.detail && /within/.test(check.name) ? ` (${check.detail})` : ''}`);
    lines.push({ kind: 'verdict', text: `${score.passed ? 'PASS' : 'FAIL'}${verdicts.length ? ` · ${verdicts.join(' · ')}` : ''}` });
    const j = score.judgement;
    if (j) lines.push({ kind: 'judge', text: `correct ${j.correct}/5 · natural ${j.natural}/5 · concise ${j.concise}/5: ${j.comment}` });
    return lines;
  });
}

const LABEL: Record<TranscriptLine['kind'], string> = { person: '', heard: 'heard', bridge: 'Nogita (bridge)', nogita: 'Nogita',
  cut: 'Nogita (cut off)', tool: 'lookup', chat: 'chat', hand: 'hand raised', task: 'Jira task', message: 'Slack message', question: 'question',
  verdict: 'result', judge: 'judge' };

export function transcriptMarkdown(results: ScenarioResult[]): string {
  const out = ['# Nogita voice lab: conversations', '',
    'Each turn: what the person said, what speech recognition heard (when different), then everything Nogita did in order.',
    'Times are seconds after the person stopped talking. "bridge" is a canned "One sec."; "lookup" is a tool call she made;',
    '"question" is a status change in her question tracker (#id status [topic]: note).', ''];
  for (const result of results) {
    const s = result.scenario;
    const passed = result.turns.filter(turn => turn.score.passed).length;
    out.push(`## ${s.title}`, '', `\`${s.name}\` · noise: ${s.noise.kind}${s.noise.kind === 'quiet' ? '' : ` at ${s.noise.snrDb} dB`} · ` +
      `people: ${s.participants.map(p => `${p.name}${p.authorized ? '' : ' (guest)'}`).join(', ')} · passed ${passed}/${result.turns.length}`, '');
    for (const error of result.errors) out.push(`> error: ${error}`, '');
    const ledger = questionLedger(result.events);
    if (ledger.length) {
      out.push('| Question | Asked by | Path | Result |', '| --- | --- | --- | --- |');
      for (const entry of ledger) {
        out.push(`| #${entry.id} ${entry.request.replace(/\|/g, '/')}${entry.topic ? ` [${entry.topic}]` : ''} | ${entry.speaker} | ` +
          `${entry.statuses.join(' → ')} | **${entry.final}**${entry.notes.length ? ` (${entry.notes.join('; ').replace(/\|/g, '/')})` : ''} |`);
      }
      out.push('');
    }
    for (const lines of transcriptLines(result)) {
      for (const line of lines) {
        if (line.kind === 'person') out.push(`**${line.who}:** ${line.text}  `);
        else out.push(`${line.at === undefined ? '' : `\`+${line.at.toFixed(1)}s\` `}*${LABEL[line.kind]}:* ${line.text}  `);
      }
      out.push('');
    }
  }
  return out.join('\n');
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
  const conversations = results.map(result => {
    const passed = result.turns.filter(turn => turn.score.passed).length;
    const s = result.scenario;
    const turns = transcriptLines(result).map((lines, i) => `<div class="turn ${result.turns[i]!.score.passed ? 'ok' : 'bad'}">${lines.map(line =>
      line.kind === 'person' ? `<div class="line person"><b>${escape(line.who ?? '')}:</b> ${escape(line.text)}</div>`
        : `<div class="line ${line.kind}">${line.at === undefined ? '<span class="at"></span>' : `<span class="at">+${line.at.toFixed(1)}s</span>`}` +
          `<span class="tag">${LABEL[line.kind]}</span> ${escape(line.text)}</div>`).join('')}</div>`).join('');
    return `<details${passed < result.turns.length ? ' open' : ''}><summary><b>${escape(s.title)}</b> <span class="muted">${escape(s.name)} · ` +
      `${escape(s.noise.kind)}${s.noise.kind === 'quiet' ? '' : ` ${s.noise.snrDb} dB`} · ${s.participants.length} ${s.participants.length === 1 ? 'person' : 'people'}</span> ` +
      `<span class="${passed === result.turns.length ? 'pass' : 'failc'}">${passed}/${result.turns.length}</span></summary>` +
      `${result.errors.map(error => `<div class="line error">error: ${escape(error)}</div>`).join('')}${turns}</details>`;
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
h2{font-size:17px;margin:28px 0 8px}.muted{color:var(--muted);font-size:12px}details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:8px 12px}
summary{cursor:pointer}.pass{color:var(--voice);font-weight:600}.failc{color:var(--bad);font-weight:600}
.turn{border-left:3px solid var(--voice);padding:6px 0 6px 10px;margin:10px 0}.turn.bad{border-left-color:var(--bad)}
.line{font-size:13px;margin:2px 0;overflow-wrap:anywhere}.at{display:inline-block;width:52px;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.tag{display:inline-block;min-width:96px;color:var(--muted);font-size:12px}.line.person{font-size:14px}.line.heard{color:var(--muted)}
.line.question{color:var(--muted);font-size:12px}.line.nogita .tag{color:var(--think);font-weight:600}.line.bridge .tag{color:var(--router)}.line.cut{color:var(--bad)}
.line.tool .tag,.line.task .tag,.line.message .tag{color:var(--stt);font-weight:600}.line.hand .tag{color:var(--router);font-weight:600}
.line.verdict{margin-top:4px;font-size:12px}.turn.bad .line.verdict{color:var(--bad)}.line.judge{font-size:12px;color:var(--muted)}.line.error{color:var(--bad)}
</style></head><body><main>
<h1>Nogita voice lab</h1><div class="sub">${escape(summary.startedAt)} · ${escape(Object.entries(summary.settings).map(([k, v]) => `${k} ${v}`).join(' · '))}</div>
<div class="tiles">${tile('Response gap p50', ms(summary.responseGap.p50))}${tile('Response gap p90', ms(summary.responseGap.p90))}${tile('Real content p50', ms(summary.contentGap.p50))}
${tile('Turns passed', `${summary.passed}/${summary.total}`)}${tile('Name recognized', `${summary.addressHeard.heard}/${summary.addressHeard.total}`)}
${tile('Answer itself p50', ms(summary.meaningfulGap.p50))}${tile('Question completion', summary.conversation.completion === undefined ? '–' : `${Math.round(summary.conversation.completion * 100)}%`)}
${tile('Lost answers', String(summary.conversation.unresolved))}${tile('Spoke over someone', String(summary.conversation.spokeOverPeople))}
${tile('Early starts used / rolled back', `${summary.conversation.earlyAdopted} / ${summary.conversation.earlyRolledBack}`)}
${tile('Transcript WER', String(summary.meanWer ?? '–'))}${summary.judge ? tile('Judge correct/natural', `${summary.judge.correct} / ${summary.judge.natural}`) : ''}</div>
<div class="legend"><span><i style="background:var(--stt)"></i>speech recognition endpoint</span><span><i style="background:var(--router)"></i>router quiet window</span>
<span><i style="background:var(--think)"></i>thinking to first sentence</span><span><i style="background:var(--voice)"></i>voice synthesis to first sound</span></div>
<table>${rows}</table>
<h2>Conversation management</h2><ul>${conversationLines(summary.conversation).map(line => `<li>${escape(line.replace(/^- /, '')).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ul>
<h2>Conversations</h2><div class="muted">Everything that happened, in order. Times are seconds after the person stopped talking. Scenarios with a failure are open.</div>
${conversations}</main></body></html>`;
}

export async function writeReport(dir: string, summary: RunSummary, results: ScenarioResult[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), markdown(summary, results));
  await writeFile(join(dir, 'report.html'), html(summary, results));
  await writeFile(join(dir, 'transcript.md'), transcriptMarkdown(results));
  await writeFile(join(dir, 'report.json'), JSON.stringify({ summary, scenarios: results.map(result => ({
    name: result.scenario.name, errors: result.errors,
    turns: result.turns.map(({ record, score }) => ({ ...record, turn: undefined, expect: record.turn.expect, score,
      events: record.events.map(event => ({ ...event, t: Math.round(event.t - record.timing.speechEnd) })),
      timing: { ...record.timing, speechStart: undefined, speechEnd: undefined,
        speechMs: Math.round(record.timing.speechEnd - record.timing.speechStart) } })),
  })) }, null, 2));
  for (const result of results) await writeFile(join(dir, `${result.scenario.name}.wav`), wav([result.room, result.nogita]));
}
