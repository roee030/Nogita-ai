/**
 * One life of the chaos test: the real MissionRunner on the real FileMissionStore, with a scripted model and a fake
 * board whose writes land in an append-only log the process cannot take back. The owner approves every write at once.
 * The harness kills this process whenever it likes; it may also ask it to kill itself right before or right after
 * an external write (the windows a crash is most likely to duplicate or lose one).
 *
 *   node tools/mission-chaos/worker.ts <state dir> <missions> <tasks per mission> [blind] [before-write:N|after-write:N]
 *
 * Prints "ready" once missions are loaded and resumed, and "settled" when none is working or waiting any more.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileMissionStore } from '../../src/app/mission-store.ts';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse } from '../../src/core/agent.ts';
import { ACTIVE_MISSION, MissionRunner, type Mission } from '../../src/core/missions.ts';

export interface BoardWrite { mission: string; title: string; key: string }

export const OWNER = { id: 'owner', displayName: 'Owner' };
export const writesFile = (directory: string) => join(directory, 'board-writes.jsonl');
export const notesFile = (directory: string) => join(directory, 'notes.jsonl');
export const missionId = (index: number) => `M-C${index + 1}`;
export const taskTitle = (mission: number, task: number) => `Chaos task ${mission + 1}.${task + 1}`;
export const GOAL_PREFIX = 'Open these tasks: ';

export function readWrites(directory: string): BoardWrite[] {
  const file = writesFile(directory);
  if (!existsSync(file)) return [];
  // A kill can cut the last line short; a partial line is not a write that happened.
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line) as BoardWrite]; } catch { return []; } });
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jitter = () => pause(Math.floor(Math.random() * 4));
const use = (name: string, input: Record<string, unknown>): AgentContent =>
  ({ type: 'tool_use', id: `${name}-${Math.random().toString(36).slice(2, 10)}`, name, input });

/**
 * Plans from the mission's own conversation, so it carries nothing across a restart: look the tasks up first and again
 * after the service restarted under a call, open the next missing one, finish with their keys. `blind` trusts only
 * its own "Created" results, as a careless agent would: the control that shows the check catches duplicates.
 */
export class ChaosPlanner implements ChatModel {
  readonly agentModel = 'chaos-planner';
  constructor(private readonly blind = false) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    await jitter();
    const content = this.plan(request);
    return { content, stopReason: 'tool_use' };
  }
  private plan(request: ChatModelRequest): AgentContent[] {
    const first = String(request.messages[0]?.content ?? '');
    const titles = (first.split(GOAL_PREFIX)[1]?.split('\n')[0] ?? '').split(' | ').map(title => title.trim()).filter(Boolean);
    const blocks = request.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content);
    const names = new Map(blocks.flatMap(block => block.type === 'tool_use' ? [[block.id, block.name] as const] : []));
    const results = blocks.filter((block): block is Extract<AgentContent, { type: 'tool_result' }> => block.type === 'tool_result');
    const last = request.messages.at(-1);
    const unsure = typeof last?.content !== 'string' && (last?.content ?? []).some(block => block.type === 'tool_result' && block.is_error &&
      /restarted/.test(block.content));
    const searched = results.some(result => names.get(result.tool_use_id) === 'search_tasks' && !result.is_error);
    if (!searched || (unsure && !this.blind)) return [use('search_tasks', {})];
    const known = new Map<string, string>();
    for (const result of results) {
      if (result.is_error || (this.blind && names.get(result.tool_use_id) !== 'create_task')) continue;
      for (const match of result.content.matchAll(/(KAN-\d+): (Chaos task [\d.]+)/g)) known.set(match[2]!, match[1]!);
    }
    const missing = titles.find(title => !known.has(title));
    if (missing) return [use('create_task', { title: missing })];
    return [use('finish_mission', { summary: `Opened ${titles.length} tasks.`, evidence: titles.map(title => known.get(title)!) })];
  }
}

/** The fake board: a write is appended (synchronously) before its result returns, like a real API call that landed. */
export function chaosBoard(directory: string, mission: Mission, crash?: { at: 'before-write' | 'after-write'; write: number }): AgentToolbox {
  const die = () => process.kill(process.pid, 'SIGKILL');
  return {
    specs: ['search_tasks', 'create_task'].map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } })),
    isWrite: name => name === 'create_task',
    async run(name, input) {
      await jitter();
      if (name === 'search_tasks') {
        const mine = readWrites(directory).filter(write => write.mission === mission.id);
        return { content: mine.length ? mine.map(write => `${write.key}: ${write.title}`).join('\n') : 'No tasks.' };
      }
      if (name !== 'create_task') return { content: 'unknown tool', isError: true };
      const count = readWrites(directory).length;
      if (crash?.at === 'before-write' && count + 1 === crash.write) die();
      const write: BoardWrite = { mission: mission.id, title: String(input.title), key: `KAN-${count + 1}` };
      appendFileSync(writesFile(directory), `${JSON.stringify(write)}\n`);
      if (crash?.at === 'after-write' && count + 1 === crash.write) die();
      await jitter();
      return { content: `Created ${write.key}: ${write.title} https://jira.example/browse/${write.key}` };
    },
  };
}

async function main(): Promise<void> {
  const [directory, missionsArg, tasksArg, ...flags] = process.argv.slice(2);
  if (!directory) throw new Error('usage: worker.ts <state dir> <missions> <tasks> [blind] [before-write:N|after-write:N]');
  const missions = Number(missionsArg ?? 3); const tasks = Number(tasksArg ?? 3);
  const point = flags.map(flag => /^(before-write|after-write):(\d+)$/.exec(flag)).find(Boolean);
  const crash = point ? { at: point[1] as 'before-write' | 'after-write', write: Number(point[2]) } : undefined;
  let nextId = '';
  const runner = new MissionRunner({ model: new ChaosPlanner(flags.includes('blind')), store: new FileMissionStore(directory),
    toolbox: mission => chaosBoard(directory, mission, crash), maxRounds: 80, newId: () => nextId,
    schedule: (work, ms) => setTimeout(work, Math.min(ms, 20)),
    notify: (mission, text) => { appendFileSync(notesFile(directory), `${JSON.stringify({ mission: mission.id, text })}\n`); } });
  await runner.resumeAll();
  for (let index = 0; index < missions; index++) {
    if (runner.get(missionId(index))) continue;
    nextId = missionId(index);
    await runner.start({ goal: `${GOAL_PREFIX}${Array.from({ length: tasks }, (_, task) => taskTitle(index, task)).join(' | ')}`, owner: OWNER });
  }
  console.log('ready');
  const approving = new Set<string>();
  for (;;) {
    const all = runner.list();
    for (const mission of all.filter(m => m.status === 'awaiting_approval' && !approving.has(m.id))) {
      approving.add(mission.id);
      void runner.approve(mission.id, OWNER.id).finally(() => approving.delete(mission.id));
    }
    if (all.length === missions && all.every(m => !ACTIVE_MISSION.has(m.status) && m.status !== 'awaiting_approval') && !approving.size) {
      await runner.idle();
      console.log('settled');
      return;
    }
    await pause(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
