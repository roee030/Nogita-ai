/**
 * Chaos test for missions: run missions that write, kill the process at random moments and right before or after an
 * external write, start it again on the same state directory, and repeat until every mission settled. Then check:
 *
 * - no duplicate writes: each requested task was created at most once;
 * - no action lost without a report: a requested task that was never created belongs to a mission that says so
 *   (blocked, failed or cancelled, with what is still open), never to one that reports done.
 *
 *   npm run mission-chaos -- [--missions 3] [--tasks 3] [--kills 8] [--seed 1] [--blind]
 *
 * `--blind` uses a planner that trusts only its own results after a restart: the check must catch its duplicates.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FileMissionStore } from '../../src/app/mission-store.ts';
import { missionReport, type MissionReport } from '../../src/core/missions.ts';
import { missionId, readWrites, taskTitle } from './worker.ts';

export interface ChaosOptions {
  missions?: number;
  tasks?: number;
  /** Random kills, spread over the run; one kill right before and one right after a write are added to them. */
  kills?: number;
  seed?: number;
  blind?: boolean;
  /** Gives up on a run that does not settle (ms). */
  timeoutMs?: number;
}

export interface ChaosResult {
  lives: number;
  kills: number;
  writes: number;
  /** "M-C1: Chaos task 1.2 x2" for each task created more than once. */
  duplicates: string[];
  /** "M-C2: Chaos task 2.3" for each requested task never created by a mission that does not say so. */
  lostUnreported: string[];
  /** Requested tasks never created, by a mission that reported it (blocked or failed with what is open). */
  reported: string[];
  missions: MissionReport[];
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

/** Small seeded generator, so a failing run can be replayed with its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

/** One life: resolves with how it ended. `killAfterMs` kills it that long after "ready". */
function life(directory: string, args: string[], killAfterMs: number | undefined, timeoutMs: number): Promise<'settled' | 'killed'> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types', WORKER, directory, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let settled = false;
    const limit = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`a life did not settle in ${timeoutMs} ms: ${err.slice(-500)}`)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      out += String(chunk);
      if (killAfterMs !== undefined && out.includes('ready')) {
        const at = killAfterMs; killAfterMs = undefined;
        setTimeout(() => child.kill('SIGKILL'), at);
      }
      if (out.includes('settled')) settled = true;
    });
    child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('exit', code => {
      clearTimeout(limit);
      // A kill leaves no error output; anything on stderr is a real failure.
      if (settled && code === 0) resolve('settled');
      else if (err.trim()) reject(new Error(`worker failed (${code}): ${err.slice(-800)}`));
      else resolve('killed');
    });
  });
}

export async function runChaos(options: ChaosOptions = {}): Promise<ChaosResult> {
  const missions = options.missions ?? 3; const tasks = options.tasks ?? 3;
  const roll = random(options.seed ?? 1);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const directory = await mkdtemp(join(tmpdir(), 'nogita-chaos-'));
  try {
    const base = [String(missions), String(tasks), ...(options.blind ? ['blind'] : [])];
    const total = missions * tasks;
    // The two windows that matter most, at writes chosen by the seed, then random kills.
    const before = 1 + Math.floor(roll() * total);
    const plan: Array<{ point?: string; killAfterMs?: number }> = [
      { point: `before-write:${before}` },
      // Not earlier than the first: the writes before it are already in the log when this life starts.
      { point: `after-write:${before + Math.floor(roll() * (total - before + 1))}` },
      ...Array.from({ length: options.kills ?? 8 }, () => ({ killAfterMs: Math.floor(roll() * 60) })),
    ];
    let lives = 0; let kills = 0;
    for (const step of plan) {
      lives++;
      const ended = await life(directory, step.point ? [...base, step.point] : base, step.killAfterMs, timeoutMs);
      if (ended === 'killed') kills++;
      else break;
    }
    // Then it runs to the end without interruption.
    for (let tries = 0; tries < 3; tries++) {
      lives++;
      if (await life(directory, base, undefined, timeoutMs) === 'settled') break;
      if (tries === 2) throw new Error('the missions did not settle after the kills');
    }

    const writes = readWrites(directory);
    const reports = (await new FileMissionStore(directory).list()).sort((a, b) => a.id.localeCompare(b.id)).map(mission => missionReport(mission));
    const duplicates: string[] = []; const lostUnreported: string[] = []; const reported: string[] = [];
    for (let index = 0; index < missions; index++) {
      const id = missionId(index);
      const report = reports.find(r => r.id === id);
      for (let task = 0; task < tasks; task++) {
        const title = taskTitle(index, task);
        const count = writes.filter(write => write.mission === id && write.title === title).length;
        if (count > 1) duplicates.push(`${id}: ${title} x${count}`);
        if (count > 0) continue;
        const says = report && report.status !== 'done' && report.open.length > 0;
        (says ? reported : lostUnreported).push(`${id}: ${title}`);
      }
    }
    return { lives, kills, writes: writes.length, duplicates, lostUnreported, reported, missions: reports };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { missions: { type: 'string' }, tasks: { type: 'string' }, kills: { type: 'string' },
    seed: { type: 'string' }, blind: { type: 'boolean' } } });
  const result = await runChaos({ missions: Number(values.missions ?? 3), tasks: Number(values.tasks ?? 3),
    kills: Number(values.kills ?? 8), seed: Number(values.seed ?? Date.now() % 100_000), blind: values.blind === true });
  console.log(`${result.lives} lives, ${result.kills} killed, ${result.writes} writes`);
  for (const report of result.missions) console.log(`${report.id} [${report.status}] done ${report.done.length}, failed ${report.failed.length}, open ${report.open.length}`);
  console.log(`duplicate writes: ${result.duplicates.length ? result.duplicates.join('; ') : 'none'}`);
  console.log(`lost without a report: ${result.lostUnreported.length ? result.lostUnreported.join('; ') : 'none'}`);
  if (result.reported.length) console.log(`not done, reported: ${result.reported.join('; ')}`);
  process.exitCode = result.duplicates.length || result.lostUnreported.length ? 1 : 0;
}
