/**
 * Builds the quality and usage dashboard (tools/dashboard/build.ts) as one HTML file.
 *
 *   npm run dashboard                                     every source at its default place
 *   npm run dashboard -- --out report.html
 *   npm run dashboard -- --turns dir --voice-lab dir --eval dir-or-file
 *
 * Defaults: <NOGITA_STATE_DIR or .nogita-state>/turns, .voice-lab/reports, .eval; the page goes to
 * <state dir>/dashboard.html. To keep eval runs for the trend, run `npm run eval -- --json .eval/<name>.json`.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { evalRuns, html, meetingRun, voiceLabRun, type Run } from './build.ts';

const list = async (directory: string) => (await readdir(directory).catch(() => [] as string[])).map(name => join(directory, name));
const readJson = async (file: string): Promise<unknown> => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
};

export async function collect(paths: { turns: string; voiceLab: string; eval: string }): Promise<Run[]> {
  const runs: Run[] = [];
  for (const file of (await list(paths.turns)).filter(file => file.endsWith('.jsonl'))) {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Record<string, unknown> & { at: number; type: string }]; } catch { return []; }
    });
    const run = meetingRun(basename(file, '.jsonl'), lines);
    if (run) runs.push(run);
  }
  for (const directory of await list(paths.voiceLab)) {
    const run = voiceLabRun(basename(directory), await readJson(join(directory, 'report.json')));
    if (run) runs.push(run);
  }
  const evalFiles = (await stat(paths.eval).catch(() => undefined))?.isFile() ? [paths.eval] : await list(paths.eval);
  for (const file of evalFiles.filter(file => file.endsWith('.json'))) runs.push(...evalRuns(basename(file, '.json'), await readJson(file)));
  return runs;
}

async function main(): Promise<void> {
  const state = process.env.NOGITA_STATE_DIR ?? '.nogita-state';
  const { values } = parseArgs({ options: { out: { type: 'string', default: join(state, 'dashboard.html') },
    turns: { type: 'string', default: join(state, 'turns') }, 'voice-lab': { type: 'string', default: join('.voice-lab', 'reports') },
    eval: { type: 'string', default: '.eval' } } });
  const runs = await collect({ turns: values.turns!, voiceLab: values['voice-lab']!, eval: values.eval! });
  await mkdir(dirname(values.out!), { recursive: true });
  await writeFile(values.out!, html(runs));
  const count = (source: Run['source']) => runs.filter(run => run.source === source).length;
  process.stdout.write(`wrote ${values.out} (${count('meeting')} meeting(s), ${count('voice-lab')} voice lab run(s), ${count('eval')} eval run(s))\n`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/dashboard/run.ts')) await main();
