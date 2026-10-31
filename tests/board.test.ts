import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatReport, parseBoard, type PullRequest } from '../tools/board.ts';

const BOARD = `
| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P1-1 | Keep truncated tool calls | Claude | \`src/core/agent.ts\`, \`src/core/engine.ts\` | - |
| [ ] | P1-2 | Repo activity tools | Claude | \`src/adapters/github.ts\`, \`src/core/engine.ts\` | P1-1 |
| [ ] | P1-4 | /version | Codex | \`src/app/server.ts\` | - |
| [ ] | P1-5 | Turn traces | Codex | \`src/app/turn-log.ts\`, \`src/core/engine.ts\` | P1-1 |
| [ ] | P1-6 | Readiness doc | Codex | \`docs/MEETING_READINESS.md\` | - |
| [x] | P1-7 | Persistent disk | רועי | (Render) | - |
| [ ] | P1-8 | Live meeting | רועי | | P1-1, P1-2 |
`;

function pr(number: number, headRefName: string, state: PullRequest['state'], extra: Partial<PullRequest> = {}): PullRequest {
  return { number, title: `PR ${number}`, headRefName, state, isDraft: false, ...extra };
}

test('the board file gives tasks, owners, files and dependencies', () => {
  const tasks = parseBoard(BOARD);
  assert.deepEqual(tasks.map(task => task.id), ['P1-1', 'P1-2', 'P1-4', 'P1-5', 'P1-6', 'P1-7', 'P1-8']);
  assert.deepEqual(tasks[1], { id: 'P1-2', title: 'Repo activity tools', owner: 'claude',
    files: ['src/adapters/github.ts', 'src/core/engine.ts'], dependsOn: ['P1-1'], checked: false });
  assert.equal(tasks[5].owner, 'roee');
  assert.equal(tasks[5].checked, true);
  assert.deepEqual(tasks[6].dependsOn, ['P1-1', 'P1-2']);
});

test('status comes from GitHub: open draft is taken, merged is done, and done unblocks what waited on it', () => {
  const tasks = parseBoard(BOARD);
  const before = buildReport(tasks, [pr(15, 'claude/P1-1-truncated', 'OPEN', { isDraft: true })], 'claude');
  assert.equal(before.tasks.find(task => task.id === 'P1-1')!.status, 'in-progress');
  assert.equal(before.tasks.find(task => task.id === 'P1-2')!.status, 'waiting');
  assert.deepEqual(before.next && [before.next.task.id, before.next.resume], ['P1-1', true]);

  const after = buildReport(tasks, [pr(15, 'claude/P1-1-truncated', 'MERGED')], 'claude');
  assert.equal(after.tasks.find(task => task.id === 'P1-1')!.status, 'done');
  assert.deepEqual(after.next && [after.next.task.id, after.next.resume], ['P1-2', false]);
});

test('a ready task that shares files with an open PR is held back, and the agent gets the next one', () => {
  const tasks = parseBoard(BOARD);
  const report = buildReport(tasks, [
    pr(15, 'claude/P1-1-truncated', 'MERGED'),
    pr(23, 'other-branch', 'OPEN', { isDraft: true, title: 'P1-2: repo activity' }),
  ], 'codex');
  assert.equal(report.tasks.find(task => task.id === 'P1-2')!.status, 'in-progress');
  assert.deepEqual(report.blocked.map(item => [item.task.id, item.by]), [['P1-5', ['P1-2']]]);
  assert.equal(report.next?.task.id, 'P1-4');
});

test('an open PR outside the board still holds its files, and Roee is told about it', () => {
  const tasks = parseBoard(BOARD);
  const stale = pr(2, 'feat/agent-brain', 'OPEN', { files: [{ path: 'src/app/server.ts' }] });
  const report = buildReport(tasks, [stale], 'codex');
  assert.deepEqual(report.blocked.map(item => [item.task.id, item.by]), [['P1-4', ['PR #2']]]);
  assert.equal(report.next?.task.id, 'P1-6');
  assert.match(formatReport(report, 'codex'), /PR #2 is not on the board/);
});

test('a broken PR comes first, a green ready PR is listed for Roee to merge, and a closed PR frees the task', () => {
  const tasks = parseBoard(BOARD);
  const report = buildReport(tasks, [
    pr(15, 'claude/P1-1-truncated', 'OPEN', { statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
    pr(21, 'codex/P1-4-version', 'OPEN', { mergeable: 'CONFLICTING' }),
    pr(19, 'codex/P1-6-readiness', 'CLOSED'),
  ], 'codex');
  const text = formatReport(report, 'codex');
  assert.match(text, /## Fix first\n- P1-4 PR #21: conflicts with main/);
  assert.match(text, /Merge PR #15 \(P1-1, claude\)/);
  assert.doesNotMatch(text, /Merge PR #21/);
  assert.equal(report.tasks.find(task => task.id === 'P1-6')!.status, 'ready');
});
