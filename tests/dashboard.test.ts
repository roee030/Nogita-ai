import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evalRuns, html, meetingRun, trends, voiceLabRun, type Run } from '../tools/dashboard/build.ts';
import { collect } from '../tools/dashboard/run.ts';

const T0 = Date.parse('2026-11-01T10:00:00Z');

function meeting(firstAudioMs: number[], usd?: number) {
  const lines: Array<Record<string, unknown> & { at: number; type: string }> = [];
  firstAudioMs.forEach((gap, id) => {
    const at = T0 + id * 60_000;
    lines.push({ at, type: 'heard', speaker: 'p_a', addressed: true, verified: true, words: 5 });
    lines.push({ at: at + 10, type: 'question', id, status: 'working', speaker: 'p_a' });
    lines.push({ at: at + gap, type: 'audio', id, phase: 'start' });
    lines.push({ at: at + gap + 500, type: 'question', id, status: 'answered', speaker: 'p_a' });
  });
  lines.push({ at: T0 + 1000, type: 'agent_trace', model: 'm', ms: 900, steps: 2, stoppedEarly: false, tools: [], stops: [],
    research: { sources: [], claims: { total: 4, sourced: 3 }, truncatedResults: [] } });
  lines.push({ at: T0 + 5000, type: 'question', id: 99, status: 'failed', speaker: 'p_b' });
  if (usd !== undefined) {
    lines.push({ at: T0 + 2000, type: 'usage', totalEstimatedUsd: usd / 2, durationSeconds: 60 });
    lines.push({ at: T0 + 9000, type: 'usage', totalEstimatedUsd: usd, durationSeconds: 300 });
  }
  return lines;
}

test('a meeting run counts missed questions, response p50/p95, sourced claims and the last cost line', () => {
  const run = meetingRun('m1', meeting([1000, 2000, 3000, 4000], 0.42))!;
  assert.equal(run.source, 'meeting');
  assert.equal(run.at, '2026-11-01T10:00:00.000Z');
  assert.equal(run.missed, 1);
  assert.equal(run.questions, 5);
  assert.equal(run.p50Ms, 2000);
  assert.equal(run.tailMs, 4000);
  assert.deepEqual(run.claims, { backed: 3, total: 4 });
  assert.equal(run.costUsd, 0.42);
  assert.equal(meetingRun('empty', []), undefined);
  assert.equal(meetingRun('no-cost', meeting([1000]))!.costUsd, undefined);
});

test('voice lab and eval reports become runs, old reports without newer fields included', () => {
  const lab = voiceLabRun('lab', { summary: { startedAt: '2026-10-29T09:28:49.934Z', responseGap: { count: 6, p50: 2254, p90: 4918 },
    passed: 7, total: 7, conversationFailures: { lostQuestions: 1, answersToOthers: 0 } } })!;
  assert.deepEqual([lab.missed, lab.p50Ms, lab.tailMs, lab.tail, lab.checks], [1, 2254, 4918, 'p90', { passed: 7, total: 7 }]);
  assert.equal(voiceLabRun('old', { summary: { startedAt: '2026-10-29T00:00:00Z', responseGap: { count: 0 } } })!.missed, undefined);
  assert.equal(voiceLabRun('broken', { nope: true }), undefined);

  const passes = evalRuns('e1', { at: '2026-11-01T12:00:00Z', passes: [
    { routing: false, summary: { cases: 4, passed: 3, claims: { total: 10, backed: 9, share: 0.9 } }, runs: [{ ms: 100 }, { ms: 200 }, { ms: 300 }, { ms: 4000 }] },
    { routing: true, summary: { cases: 4, passed: 4, claims: { total: 0, backed: 0, share: 1 } }, runs: [] },
  ] });
  assert.equal(passes.length, 2);
  assert.deepEqual([passes[0]!.name, passes[0]!.missed, passes[0]!.p50Ms, passes[0]!.tailMs, passes[0]!.claims],
    ['e1 (routing off)', 1, 200, 4000, { backed: 9, total: 10 }]);
  assert.equal(passes[1]!.claims, undefined, 'no claims is not 100% sourced');
  assert.deepEqual(evalRuns('bad', {}), []);
});

test('trend compares the latest run with the previous one and says which way is better', () => {
  const runs: Run[] = [
    { source: 'meeting', name: 'b', at: '2026-11-02T00:00:00Z', missed: 0, p50Ms: 1500, tailMs: 3000, tail: 'p95', costUsd: 0.5, claims: { backed: 9, total: 10 } },
    { source: 'meeting', name: 'a', at: '2026-11-01T00:00:00Z', missed: 2, p50Ms: 1200, tailMs: 3000, tail: 'p95', costUsd: 0.4 },
  ];
  const byName = Object.fromEntries(trends(runs, 'meeting').map(trend => [trend.metric, trend]));
  assert.equal(byName['Missed questions']!.better, true);
  assert.equal(byName['Response p50']!.better, false);
  assert.equal(byName['Response p95']!.better, undefined, 'unchanged');
  assert.equal(byName['Cost per meeting']!.better, false);
  assert.equal(byName['Claims with a source']!.latest, 0.9);
  assert.equal(byName['Claims with a source']!.better, undefined, 'no number for the previous run');
});

test('collect reads every source from disk and the page shows each one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-dashboard-'));
  const turns = join(root, 'turns'); const lab = join(root, 'lab'); const evals = join(root, 'eval');
  await mkdir(turns); await mkdir(join(lab, '2026-10-29T09-28'), { recursive: true }); await mkdir(evals);
  await writeFile(join(turns, 'meet-1.jsonl'), `${meeting([1000, 2000], 0.3).map(line => JSON.stringify(line)).join('\n')}\nnot json\n`);
  await writeFile(join(lab, '2026-10-29T09-28', 'report.json'), JSON.stringify({ summary: { startedAt: '2026-10-29T09:28:49Z',
    responseGap: { count: 1, p50: 900, p90: 900 }, passed: 1, total: 1 } }));
  await writeFile(join(evals, 'run.json'), JSON.stringify({ at: '2026-11-01T12:00:00Z', passes: [{ routing: false,
    summary: { cases: 2, passed: 2, claims: { total: 2, backed: 2 } }, runs: [{ ms: 10 }, { ms: 20 }] }] }));
  const runs = await collect({ turns, voiceLab: lab, eval: evals });
  assert.deepEqual(runs.map(run => run.source).sort(), ['eval', 'meeting', 'voice-lab']);
  const page = html(runs, '2026-11-01T13:00:00Z');
  for (const text of ['Real meetings', 'Voice lab', 'Eval set', 'meet-1', '$0.30', 'Cost per meeting', 'p90']) assert.ok(page.includes(text), text);
  assert.ok(!page.includes('No runs found.'));
  assert.ok(html([]).includes('No runs found.'));
  assert.deepEqual(await collect({ turns: join(root, 'missing'), voiceLab: join(root, 'missing'), eval: join(root, 'missing') }), []);
});
