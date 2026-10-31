/**
 * Shared state for the agents working on this repository (docs/TASK_BOARD.md has the rules).
 *
 *   npm run board -- --agent claude|codex
 *
 * The board file says what the tasks are: owner, files and dependencies. GitHub says where each one stands, so
 * nobody has to remember to update a status: a merged PR means done, an open draft means taken, a ready PR means
 * waiting for review. Prints what this agent should do next and what is waiting on Roee.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Owner = 'claude' | 'codex' | 'roee';
export type Status = 'done' | 'in-progress' | 'in-review' | 'ready' | 'waiting';

export interface Task {
  id: string;
  title: string;
  owner: Owner;
  files: string[];
  dependsOn: string[];
  /** Ticked by hand on the board: done without a PR (Roee's own tasks). */
  checked: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  mergeable?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<{ conclusion?: string | null; status?: string; state?: string }>;
  files?: Array<{ path: string }>;
  url?: string;
}

export interface TaskState extends Task {
  status: Status;
  pr?: PullRequest;
  problems: string[];
}

export interface BoardReport {
  tasks: TaskState[];
  /** The one task this agent should work on now: its open task first, else the first ready one. */
  next?: { task: TaskState; resume: boolean };
  /** Ready tasks of this agent held back because an open PR touches the same files. */
  blocked: Array<{ task: TaskState; by: string[] }>;
  /** Open PRs that no board task owns; their files still count as taken. */
  outside: PullRequest[];
}

const TASK_ID = /^P\d+-\d+$/;
const OWNERS: Record<string, Owner> = { claude: 'claude', codex: 'codex', 'רועי': 'roee', roee: 'roee' };

/** Rows of the form `| [ ] | P1-2 | title | Claude | `src/a.ts`, `tests/b.test.ts` | P1-1 |`. */
export function parseBoard(markdown: string): Task[] {
  const tasks: Task[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 6 || !TASK_ID.test(cells[1])) continue;
    const owner = OWNERS[cells[3].toLowerCase()];
    if (!owner) throw new Error(`${cells[1]}: unknown owner "${cells[3]}"`);
    tasks.push({
      id: cells[1], title: cells[2], owner,
      files: [...cells[4].matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(path => /[/.]/.test(path)),
      dependsOn: cells[5].split(/[,\s]+/).filter(id => TASK_ID.test(id)),
      checked: /\[x\]/i.test(cells[0]),
    });
  }
  return tasks;
}

/** The task a PR belongs to, from its branch (`claude/P1-2-...`) or its title (`P1-2: ...`). */
export function taskOf(pr: PullRequest): string | undefined {
  return /^(?:claude|codex)\/(P\d+-\d+)(?:-|$)/.exec(pr.headRefName)?.[1] ?? /^(P\d+-\d+):/.exec(pr.title)?.[1];
}

function overlaps(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}

function problemsOf(pr: PullRequest): string[] {
  const problems: string[] = [];
  const failed = (pr.statusCheckRollup ?? []).some(check =>
    ['FAILURE', 'TIMED_OUT', 'ERROR'].includes((check.conclusion ?? check.state ?? '').toUpperCase()));
  if (failed) problems.push('CI is failing');
  if (pr.mergeable === 'CONFLICTING') problems.push('conflicts with main');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') problems.push('changes requested');
  return problems;
}

export function buildReport(tasks: Task[], prs: PullRequest[], agent: Owner): BoardReport {
  // Per task, the open PR wins over a merged one; a PR closed without merging does not count.
  const prOf = new Map<string, PullRequest>();
  for (const pr of prs) {
    const id = taskOf(pr);
    if (!id || pr.state === 'CLOSED') continue;
    const current = prOf.get(id);
    if (!current || (pr.state === 'OPEN' && current.state !== 'OPEN')) prOf.set(id, pr);
  }
  const done = new Set(tasks.filter(task => task.checked || prOf.get(task.id)?.state === 'MERGED').map(task => task.id));
  const states: TaskState[] = tasks.map(task => {
    const pr = prOf.get(task.id);
    const status: Status = done.has(task.id) ? 'done'
      : pr?.state === 'OPEN' ? (pr.isDraft ? 'in-progress' : 'in-review')
        : task.dependsOn.every(id => done.has(id)) ? 'ready' : 'waiting';
    return { ...task, status, pr, problems: pr?.state === 'OPEN' ? problemsOf(pr) : [] };
  });

  const known = new Set(tasks.map(task => task.id));
  const outside = prs.filter(pr => pr.state === 'OPEN' && !known.has(taskOf(pr) ?? ''));
  const taken = [
    ...states.filter(task => task.status === 'in-progress' || task.status === 'in-review')
      .flatMap(task => task.files.map(path => ({ path, by: task.id }))),
    ...outside.flatMap(pr => (pr.files ?? []).map(file => ({ path: file.path, by: `PR #${pr.number}` }))),
  ];

  const mine = states.filter(task => task.owner === agent);
  const open = mine.find(task => task.status === 'in-progress');
  const blocked: BoardReport['blocked'] = [];
  let next: BoardReport['next'] = open ? { task: open, resume: true } : undefined;
  for (const task of mine.filter(task => task.status === 'ready')) {
    const by = [...new Set(taken.filter(item => task.files.some(path => overlaps(path, item.path))).map(item => item.by))];
    if (by.length) blocked.push({ task, by });
    else next ??= { task, resume: false };
  }
  return { tasks: states, next, blocked, outside };
}

export function formatReport(report: BoardReport, agent: Owner): string {
  const lines: string[] = [];
  const mine = report.tasks.filter(task => task.owner === agent);
  const broken = mine.filter(task => task.problems.length);
  lines.push(`# Board for ${agent}`, '');
  if (broken.length) {
    lines.push('## Fix first');
    for (const task of broken) lines.push(`- ${task.id} PR #${task.pr!.number}: ${task.problems.join(', ')}`);
    lines.push('');
  }
  lines.push('## Next');
  if (report.next) {
    const { task, resume } = report.next;
    lines.push(resume
      ? `- Continue ${task.id} on its branch (${task.pr!.headRefName}, draft PR #${task.pr!.number}): ${task.title}`
      : `- Start ${task.id}: ${task.title}`);
    lines.push(`  Files: ${task.files.join(', ') || '(none listed)'}`);
  } else {
    lines.push('- Nothing to start. Stop and report what is waiting on Roee.');
  }
  for (const item of report.blocked) lines.push(`- Held back: ${item.task.id} shares files with ${item.by.join(', ')}`);
  lines.push('');

  const toMerge = report.tasks.filter(task => task.status === 'in-review' && !task.problems.length);
  const human = report.tasks.filter(task => task.owner === 'roee' && task.status === 'ready');
  lines.push('## Waiting on Roee');
  for (const task of toMerge) lines.push(`- Merge PR #${task.pr!.number} (${task.id}, ${task.owner})`);
  for (const task of human) lines.push(`- Do ${task.id}: ${task.title}`);
  for (const pr of report.outside) lines.push(`- PR #${pr.number} is not on the board: close it or add a task (${pr.headRefName})`);
  if (!toMerge.length && !human.length && !report.outside.length) lines.push('- Nothing.');
  lines.push('');

  lines.push('## All tasks');
  for (const task of report.tasks) {
    const pr = task.pr ? ` PR #${task.pr.number}` : '';
    const waits = task.status === 'waiting' ? ` (after ${task.dependsOn.join(', ')})` : '';
    lines.push(`- ${task.id} [${task.status}] ${task.owner}${pr}${waits}: ${task.title}`);
  }
  return lines.join('\n');
}

function main(): void {
  const at = process.argv.indexOf('--agent');
  const agent = OWNERS[(process.argv[at + 1] ?? '').toLowerCase()];
  if (at < 0 || !agent || agent === 'roee') throw new Error('usage: npm run board -- --agent claude|codex');
  const board = readFileSync(new URL('../docs/TASK_BOARD.md', import.meta.url), 'utf8');
  const prs = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json',
    'number,title,headRefName,state,isDraft,mergeable,reviewDecision,statusCheckRollup,files,url'], { encoding: 'utf8' })) as PullRequest[];
  console.log(formatReport(buildReport(parseBoard(board), prs, agent), agent));
}

if (process.argv[1]?.endsWith('board.ts')) main();
