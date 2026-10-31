import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { analyseSession, renderComparison, type ProbeSession } from '../tools/listener-probe/analyse.ts';

const exec = promisify(execFile);

function session(frames: Array<[number, number]>, markers: ProbeSession['markers']): ProbeSession {
  return { version: 1, meeting: 'meet-2', recordedAt: '2026-10-31T10:00:00.000Z', frameMs: 20,
    threshold: 0.05, frames: frames.map(([atMs, rms]) => ({ atMs, rms })), markers };
}

test('listener probe requires sustained sound after a question and reports missing transitions honestly', () => {
  const frames: Array<[number, number]> = [];
  for (let at = 0; at <= 1_000; at += 20) frames.push([at, at === 120 || (at >= 200 && at < 300) ? 0.1 : 0.001]);
  const result = analyseSession(session(frames, [
    { kind: 'question_end', atMs: 100, label: 'q1' },
    { kind: 'question_end', atMs: 900, label: 'q2' },
  ]));
  assert.deepEqual(result.questionToSound, [
    { label: 'q1', markerAtMs: 100, transitionAtMs: 200, latencyMs: 100 },
    { label: 'q2', markerAtMs: 900, transitionAtMs: null, latencyMs: null },
  ]);
});

test('listener probe does not join timer samples separated by browser throttling into sustained sound', () => {
  const result = analyseSession(session([[0, 0.001], [200, 0.1], [1_000, 0.1], [2_000, 0.1]], [
    { kind: 'question_end', atMs: 100 },
  ]));
  assert.equal(result.questionToSound[0]?.latencyMs, null);
});

test('listener probe measures wait until a full quiet window and normalizes unordered input', () => {
  const frames: Array<[number, number]> = [];
  for (let at = 0; at <= 1_000; at += 20) frames.unshift([at, at < 500 ? 0.1 : 0.001]);
  const markers: ProbeSession['markers'] = [
    { kind: 'wait', atMs: 100, label: 'wait 1' },
    { kind: 'wait', atMs: 900, label: 'wait 2' },
  ];
  const result = analyseSession(session(frames, markers.reverse()));
  assert.deepEqual(result.waitToSilence, [
    { label: 'wait 1', markerAtMs: 100, transitionAtMs: 500, latencyMs: 400 },
    { label: 'wait 2', markerAtMs: 900, transitionAtMs: null, latencyMs: null },
  ]);
});

test('comparison report keeps per-meeting sample counts, percentiles, and missing measurements', () => {
  const frames: Array<[number, number]> = [];
  for (let at = 0; at <= 1_000; at += 20) frames.push([at, at >= 200 && at < 500 ? 0.1 : 0.001]);
  const result = analyseSession(session(frames, [
    { kind: 'question_end', atMs: 100 }, { kind: 'wait', atMs: 300 }, { kind: 'wait', atMs: 900 },
  ]));
  const report = renderComparison([result]);
  assert.match(report, /\| meet-2 \| 1 \| 100 ms \| 100 ms \| 1\/2 \| 200 ms \| 200 ms \|/);
  assert.match(report, /wait: 900 ms → no stable silence observed/);
});

test('listener probe CLI writes a comparison report from exported session files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'listener-probe-'));
  const input = join(directory, 'meeting.json');
  const output = join(directory, 'comparison.md');
  await writeFile(input, JSON.stringify(session([
    [0, 0.001], [100, 0.001], [120, 0.1], [140, 0.1], [160, 0.1], [200, 0.001],
  ], [{ kind: 'question_end', atMs: 100 }])));
  await exec(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types',
    'tools/listener-probe/run.ts', 'report', input, '--out', output], { cwd: process.cwd() });
  assert.match(await readFile(output, 'utf8'), /\| meet-2 \| 1 \| 20 ms \| 20 ms \|/);
});
