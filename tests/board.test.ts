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
    files: ['src/adapters/github.ts', 'src/core/engine.ts'], dependsOn: ['P1-1'], checked: false, deferred: false });
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

test('a task Roee put off holds back what depends on it, and is not listed as something for him to do', () => {
  const board = BOARD.replace('| [ ] | P1-8 |', '| [-] | P1-8 |') +
    '| [ ] | P2-7 | Fix wait | Codex | `src/core/speech-floor.ts` | P1-8 |\n| [ ] | P2-8 | Meeting 3 | רועי | | P2-7 |\n';
  const tasks = parseBoard(board);
  assert.equal(tasks.find(task => task.id === 'P1-8')!.deferred, true);
  const report = buildReport(tasks, [], 'codex');
  const status = (id: string) => report.tasks.find(task => task.id === id)!.status;
  assert.deepEqual(['P1-8', 'P2-7', 'P2-8'].map(status), ['deferred', 'deferred', 'deferred']);
  const text = formatReport(report, 'codex');
  assert.doesNotMatch(text, /Do P1-8/);
  assert.match(text, /Put off by Roee, no action now: P1-8, P2-7, P2-8/);
});

test('in a chain, the agent builds on its own PRs waiting for review instead of waiting for a merge', () => {
  const tasks = parseBoard(BOARD);
  const prs = [pr(15, 'claude/P1-1-truncated', 'OPEN')];
  const plain = buildReport(tasks, prs, 'claude');
  assert.equal(plain.tasks.find(task => task.id === 'P1-2')!.status, 'waiting');
  assert.equal(plain.next, undefined);

  const chain = buildReport(tasks, prs, 'claude', { chain: true });
  assert.equal(chain.tasks.find(task => task.id === 'P1-1')!.status, 'in-review');
  assert.equal(chain.tasks.find(task => task.id === 'P1-2')!.status, 'ready');
  // engine.ts is in both, but the new branch carries P1-1's work, so it is not held back.
  assert.deepEqual(chain.next && [chain.next.task.id, chain.next.buildsOn?.map(item => item.number)], ['P1-2', [15]]);
  assert.match(formatReport(chain, 'claude'), /merge origin\/claude\/P1-1-truncated into the new branch/);
  // Another agent's PR waiting for review is still a dependency to wait for.
  const codex = buildReport(tasks, prs, 'codex', { chain: true });
  assert.equal(codex.tasks.find(task => task.id === 'P1-5')!.status, 'waiting');
});
