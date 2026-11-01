/**
 * Quality and usage dashboard: one HTML page from the three places runs leave numbers behind.
 *
 *   meetings   <state dir>/turns/*.jsonl (src/app/turn-log.ts), one file per meeting, read through tools/turn-report.ts
 *   voice lab  .voice-lab/reports/<time>/report.json (tools/voice-lab/report.ts)
 *   eval       .eval/*.json, written by `npm run eval -- --json .eval/<name>.json` (tests/eval/run.ts)
 *
 * Every number comes from what a run recorded; a measure a source does not record is shown as "–", never guessed.
 * Cost per meeting needs NOGITA_USAGE_LOG=true on the server (the turn log's `usage` lines).
 */
import { analyse, percentile } from '../turn-report.ts';

export type Source = 'meeting' | 'voice-lab' | 'eval';

export interface Run {
  source: Source;
  name: string;
  /** ISO time the run started. */
  at: string;
  /** Questions lost or never answered. */
  missed?: number;
  questions?: number;
  /** Response time: meetings, transcript to first audio; voice lab, end of speech to first audio; eval, whole case. */
  p50Ms?: number;
  tailMs?: number;
  /** The voice lab records p90, not p95. */
  tail: 'p95' | 'p90';
  claims?: { backed: number; total: number };
  costUsd?: number;
  minutes?: number;
  checks?: { passed: number; total: number };
}

type Line = Record<string, unknown> & { at: number; type: string };

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined;

export function meetingRun(name: string, lines: readonly Line[]): Run | undefined {
  if (!lines.length) return undefined;
  const report = analyse(name, lines);
  const usage = lines.filter(line => line.type === 'usage').sort((a, b) => a.at - b.at).at(-1);
  const { claims, sourcedClaims } = report.traces.research;
  return { source: 'meeting', name, at: new Date(Math.min(...lines.map(line => line.at))).toISOString(),
    missed: report.missed.length, questions: report.questions,
    p50Ms: percentile(report.firstAudioMs, 50), tailMs: percentile(report.firstAudioMs, 95), tail: 'p95',
    ...(claims ? { claims: { backed: sourcedClaims, total: claims } } : {}),
    ...(usage && num(usage.totalEstimatedUsd) !== undefined ? { costUsd: num(usage.totalEstimatedUsd) } : {}),
    minutes: report.minutes };
}

export function voiceLabRun(name: string, json: unknown): Run | undefined {
  const summary = record(record(json)?.summary);
  if (!summary || typeof summary.startedAt !== 'string') return undefined;
  const gap = record(summary.responseGap);
  const lost = num(record(summary.conversationFailures)?.lostQuestions);
  const passed = num(summary.passed); const total = num(summary.total);
  return { source: 'voice-lab', name, at: summary.startedAt,
    ...(lost !== undefined ? { missed: lost } : {}), ...(total !== undefined ? { questions: total } : {}),
    p50Ms: num(gap?.p50), tailMs: num(gap?.p90), tail: 'p90',
    ...(passed !== undefined && total !== undefined ? { checks: { passed, total } } : {}) };
}

/** One run per pass: `--routing compare` writes two. */
export function evalRuns(name: string, json: unknown): Run[] {
  const file = record(json);
  const at = typeof file?.at === 'string' ? file.at : undefined;
  if (!at || !Array.isArray(file!.passes)) return [];
  return file!.passes.flatMap((item, index, passes) => {
    const pass = record(item);
    const summary = record(pass?.summary);
    if (!pass || !summary) return [];
    const ms = Array.isArray(pass.runs) ? pass.runs.map(run => num(record(run)?.ms)).filter((v): v is number => v !== undefined) : [];
    const claims = record(summary.claims);
    const backed = num(claims?.backed); const total = num(claims?.total);
    const cases = num(summary.cases) ?? 0; const passed = num(summary.passed) ?? 0;
    return [{ source: 'eval' as const, at,
      name: passes.length > 1 ? `${name} (routing ${pass.routing ? 'on' : 'off'})` : name,
      missed: cases - passed, questions: cases, p50Ms: percentile(ms, 50), tailMs: percentile(ms, 95), tail: 'p95' as const,
      ...(backed !== undefined && total ? { claims: { backed, total } } : {}), checks: { passed, total: cases } }];
  });
}

export interface Trend { metric: string; latest?: number; previous?: number; better?: boolean; unit: 'count' | 'ms' | 'share' | 'usd' }

const share = (run: Run) => run.claims && run.claims.total ? run.claims.backed / run.claims.total : undefined;

/** Latest run against the one before it, per source; `better` is undefined when either side has no number. */
export function trends(runs: readonly Run[], source: Source): Trend[] {
  const list = runs.filter(run => run.source === source).sort((a, b) => a.at.localeCompare(b.at));
  const [previous, latest] = [list.at(-2), list.at(-1)];
  const metric = (name: string, unit: Trend['unit'], pick: (run: Run) => number | undefined, lowerIsBetter: boolean): Trend => {
    const a = latest ? pick(latest) : undefined; const b = previous ? pick(previous) : undefined;
    return { metric: name, unit, ...(a !== undefined ? { latest: a } : {}), ...(b !== undefined ? { previous: b } : {}),
      ...(a !== undefined && b !== undefined && a !== b ? { better: lowerIsBetter ? a < b : a > b } : {}) };
  };
  return [
    metric('Missed questions', 'count', run => run.missed, true),
    metric('Response p50', 'ms', run => run.p50Ms, true),
    metric(`Response ${list.at(-1)?.tail ?? 'p95'}`, 'ms', run => run.tailMs, true),
    metric('Claims with a source', 'share', share, false),
    ...(source === 'meeting' ? [metric('Cost per meeting', 'usd', (run: Run) => run.costUsd, true)] : []),
    ...(source !== 'meeting' ? [metric('Checks passed', 'share', (run: Run) => run.checks?.total ? run.checks.passed / run.checks.total : undefined, false)] : []),
  ];
}

const SOURCES: Array<{ id: Source; title: string; note: string }> = [
  { id: 'meeting', title: 'Real meetings', note: 'Turn logs. Response = transcript received to first audio sent. Cost needs NOGITA_USAGE_LOG=true.' },
  { id: 'voice-lab', title: 'Voice lab', note: 'Response = end of speech to first audio. Missed = lost questions. The lab records p90, not p95.' },
  { id: 'eval', title: 'Eval set', note: 'Missed = cases that failed a check. Response = whole case through the agent loop.' },
];

const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function format(value: number | undefined, unit: Trend['unit']): string {
  if (value === undefined) return '–';
  if (unit === 'ms') return `${(value / 1000).toFixed(2)} s`;
  if (unit === 'share') return `${Math.round(value * 100)}%`;
  if (unit === 'usd') return `$${value.toFixed(2)}`;
  return String(value);
}

/** A small line of one measure over a source's runs, oldest first; nothing when fewer than two runs have it. */
function sparkline(values: Array<number | undefined>): string {
  const points = values.map((value, index) => ({ value, index })).filter((p): p is { value: number; index: number } => p.value !== undefined);
  if (points.length < 2) return '';
  const min = Math.min(...points.map(p => p.value)); const max = Math.max(...points.map(p => p.value));
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * 96 + 2;
  const y = (v: number) => max === min ? 12 : 22 - ((v - min) / (max - min)) * 20;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.index).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const last = points.at(-1)!;
  return `<svg class="spark" viewBox="0 0 100 24" aria-hidden="true"><path d="${path}"/><circle cx="${x(last.index).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2"/></svg>`;
}

function section(runs: readonly Run[], source: typeof SOURCES[number]): string {
  const list = runs.filter(run => run.source === source.id).sort((a, b) => a.at.localeCompare(b.at));
  if (!list.length) return `<section><h2>${source.title}</h2><p class="muted">No runs found.</p></section>`;
  const pickers: Record<string, (run: Run) => number | undefined> = {
    'Missed questions': run => run.missed, 'Response p50': run => run.p50Ms, 'Response p95': run => run.tailMs,
    'Response p90': run => run.tailMs, 'Claims with a source': share, 'Cost per meeting': run => run.costUsd,
    'Checks passed': run => run.checks?.total ? run.checks.passed / run.checks.total : undefined,
  };
  const tiles = trends(runs, source.id).map(trend => {
    const arrow = trend.better === undefined ? '' : `<span class="${trend.better ? 'good' : 'bad'}">${trend.better ? '▲ better' : '▼ worse'}</span>`;
    return `<div class="tile"><div class="label">${escape(trend.metric)}</div><div class="value">${format(trend.latest, trend.unit)}</div>
<div class="delta">${trend.previous !== undefined ? `was ${format(trend.previous, trend.unit)} ` : ''}${arrow}</div>${sparkline(list.map(pickers[trend.metric] ?? (() => undefined)))}</div>`;
  }).join('');
  const costs = list.map(run => run.costUsd).filter((v): v is number => v !== undefined);
  const extra = source.id === 'meeting' && costs.length
    ? `<p>Mean cost per meeting ${format(costs.reduce((a, b) => a + b, 0) / costs.length, 'usd')} over ${costs.length} meeting(s) with a cost line.</p>` : '';
  const rows = [...list].reverse().map(run => `<tr><td>${escape(run.at.slice(0, 16).replace('T', ' '))}</td><td>${escape(run.name)}</td>
<td>${run.missed ?? '–'}${run.questions !== undefined ? ` / ${run.questions}` : ''}</td><td>${format(run.p50Ms, 'ms')}</td><td>${format(run.tailMs, 'ms')}</td>
<td>${run.claims ? `${run.claims.backed} / ${run.claims.total}` : '–'}</td>${source.id === 'meeting'
    ? `<td>${format(run.costUsd, 'usd')}</td><td>${run.minutes ?? '–'}</td>` : `<td>${run.checks ? `${run.checks.passed} / ${run.checks.total}` : '–'}</td>`}</tr>`).join('');
  const tail = list.at(-1)!.tail;
  return `<section><h2>${source.title} <span class="muted">· ${list.length} run(s)</span></h2><p class="muted">${source.note}</p>
<div class="tiles">${tiles}</div>${extra}
<div class="scroll"><table><thead><tr><th>Started</th><th>Run</th><th>Missed / asked</th><th>p50</th><th>${tail}</th><th>Claims sourced</th>${source.id === 'meeting'
    ? '<th>Cost</th><th>Minutes</th>' : '<th>Checks</th>'}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function html(runs: readonly Run[], builtAt = new Date().toISOString()): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nogita Quality Dashboard</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--good:#15803d;--bad:#b91c1c;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--good:#4ade80;--bad:#f87171;--accent:#a5b4fc}}
:root[data-theme="dark"]{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--good:#4ade80;--bad:#f87171;--accent:#a5b4fc}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 4px}.muted{color:var(--muted);font-weight:400;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin:12px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.label{font-size:12px;color:var(--muted)}
.value{font-size:22px;font-variant-numeric:tabular-nums}.delta{font-size:12px;color:var(--muted);min-height:18px}
.good{color:var(--good)}.bad{color:var(--bad)}.spark{width:100%;height:24px;margin-top:4px}.spark path{fill:none;stroke:var(--accent);stroke-width:1.5}.spark circle{fill:var(--accent)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500}
</style></head><body><main><h1>Nogita quality and usage</h1><div class="muted">Built ${escape(builtAt)} from ${runs.length} run(s). Arrows compare the latest run with the one before it.</div>
${SOURCES.map(source => section(runs, source)).join('\n')}</main></body></html>
`;
}
