/**
 * Builds the quality and usage dashboard (tools/dashboard/build.ts) as one HTML file.
 *
 *   npm run dashboard                                     every source at its default place
 *   npm run dashboard -- --out report.html
 *   npm run dashboard -- --turns dir --voice-lab dir --eval dir-or-file
 *
 * Defaults: <NOGITA_STATE_DIR or .nogita-state>/turns, .voice-lab/reports, .eval, and <state dir>/audit/writes.jsonl
 * (--audit) for the phase 5 gates; the page goes to
 * <state dir>/dashboard.html. To keep eval runs for the trend, run `npm run eval -- --json .eval/<name>.json`.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { evalRuns, html, meetingRun, phase5Gates, voiceLabRun, type AuditLine, type Run } from './build.ts';

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

/** The audit log's lines, or undefined when there is no log (NOGITA_AUDIT_LOG off); a line cut short by a crash is skipped. */
export async function readAudit(file: string): Promise<AuditLine[] | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  return text.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as AuditLine]; } catch { return []; }
  });
}

async function main(): Promise<void> {
  const state = process.env.NOGITA_STATE_DIR ?? '.nogita-state';
  const { values } = parseArgs({ options: { out: { type: 'string', default: join(state, 'dashboard.html') },
    turns: { type: 'string', default: join(state, 'turns') }, 'voice-lab': { type: 'string', default: join('.voice-lab', 'reports') },
    eval: { type: 'string', default: '.eval' }, audit: { type: 'string', default: join(state, 'audit', 'writes.jsonl') } } });
  const runs = await collect({ turns: values.turns!, voiceLab: values['voice-lab']!, eval: values.eval! });
  const audit = await readAudit(values.audit!);
  loadDotEnv();
  const authorized = new Set((process.env.AUTHORIZED_ACTOR_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  await mkdir(dirname(values.out!), { recursive: true });
  await writeFile(values.out!, html(runs, undefined, phase5Gates(runs, audit, authorized)));
  const count = (source: Run['source']) => runs.filter(run => run.source === source).length;
  process.stdout.write(`wrote ${values.out} (${count('meeting')} meeting(s), ${count('voice-lab')} voice lab run(s), ${count('eval')} eval run(s))\n`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/dashboard/run.ts')) await main();
