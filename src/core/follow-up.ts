/**
 * NOGITA_FOLLOW_UP: closing the loop (docs/WORK_PLAN.md, phase 8). When she joins the next meeting she posts, in the
 * chat, what happened to the tasks she opened in the last days: what closed, what moved, what is stuck. The list comes
 * from the board itself (her request property marks her tasks), so it survives restarts and redeploys, which the
 * server's own state does not on Render.
 */
export interface OwnTask {
  key: string;
  title: string;
  status?: string;
  /** The board says the status is a finished one. */
  done: boolean;
  created: number;
  updated: number;
  assignee?: string;
  url: string;
}

const DAY = 86_400_000;
/** Not done, and nobody touched it for this long. */
export const STUCK_AFTER_MS = 2 * DAY;

export function followUp(tasks: readonly OwnTask[], now: number): string | undefined {
  if (!tasks.length) return undefined;
  const done = tasks.filter(task => task.done);
  const open = tasks.filter(task => !task.done);
  const stuck = open.filter(task => now - task.updated >= STUCK_AFTER_MS);
  const moving = open.filter(task => now - task.updated < STUCK_AFTER_MS);
  const line = (task: OwnTask) => `${task.key} ${task.title}${task.status ? ` (${task.status}` : ''}${task.assignee ? `${task.status ? ', ' : ' ('}${task.assignee}` : ''}${task.status || task.assignee ? ')' : ''} ${task.url}`;
  const days = (ms: number) => Math.max(1, Math.round(ms / DAY));
  const lines = [`Follow-up on the ${tasks.length} task${tasks.length === 1 ? '' : 's'} I opened recently: ${done.length} done, ${moving.length} moving, ${stuck.length} stuck.`];
  if (stuck.length) {
    lines.push('', 'Stuck (no change for 2 days or more):');
    for (const task of stuck) lines.push(`- ${line(task)}, untouched ${days(now - task.updated)} day${days(now - task.updated) === 1 ? '' : 's'}${task.assignee ? '' : ', and nobody owns it'}`);
  }
  if (moving.length) { lines.push('', 'Moving:'); for (const task of moving) lines.push(`- ${line(task)}`); }
  if (done.length) { lines.push('', 'Done:'); for (const task of done) lines.push(`- ${line(task)}`); }
  return lines.join('\n');
}
