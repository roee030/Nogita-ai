import test from 'node:test';
import assert from 'node:assert/strict';
import { JiraBoard } from '../src/adapters/jira.ts';
import { MemoryBoard, MemoryCode } from '../src/adapters/memory.ts';
import { MultiBoard, MultiCode } from '../src/adapters/multi.ts';
import { boardConformance, codeConformance } from './conformance/kits.ts';
import { jiraFake } from './conformance/jira-fake.ts';

const dana = { id: 'dana', name: 'Dana Katz' };
const people = new Map([['dana', 'Dana Katz']]);

function jira(projectKey = 'KAN'): JiraBoard {
  return new JiraBoard({ baseUrl: 'https://team.atlassian.net', email: 'bot@team.example', token: 't', projectKey, issueType: 'Task',
    resolveAssigneeId: id => (id === 'dana' ? 'acc-dana' : undefined) }, jiraFake([{ accountId: 'acc-dana', displayName: 'Dana Katz' }]));
}

boardConformance('memory board', () => ({ board: new MemoryBoard('memory', 'MEM', people), person: dana, initialStatus: 'To Do' }),
  { idempotent: true });
boardConformance('jira board', () => ({ board: jira(), person: dana, initialStatus: 'To Do' }), { idempotent: true });
boardConformance('several boards (memory + memory)', () => ({
  board: new MultiBoard([{ id: 'web', board: new MemoryBoard('memory', 'WEB', people) },
    { id: 'mobile', board: new MemoryBoard('memory', 'MOB', people) }]), person: dana, initialStatus: 'To Do' }), { idempotent: true });
boardConformance('several boards (jira + memory)', () => ({
  board: new MultiBoard([{ id: 'jira', board: jira() }, { id: 'ops', board: new MemoryBoard('memory', 'OPS', people) }]),
  person: dana, initialStatus: 'To Do' }), { idempotent: true });

const files = { 'README.md': '# Shop\nAn online shop.', 'src/payments/retry.ts': 'export function retry() {\n  // backoff with jitter\n  return 3;\n}' };
codeConformance('memory repository', () => ({ code: new MemoryCode('shop', files), path: 'src/payments/retry.ts', word: 'jitter' }));
codeConformance('several repositories', () => ({
  code: new MultiCode([{ id: 'shop', code: new MemoryCode('shop', files) }, { id: 'app', code: new MemoryCode('app', { 'main.ts': 'start()' }) }]),
  path: 'shop/src/payments/retry.ts', word: 'jitter' }));

test('several boards: tasks go to the default unless one is named, and a person stays on the board they were found on', async () => {
  const web = new MemoryBoard('memory', 'WEB', people);
  const mobile = new MemoryBoard('memory', 'MOB', people);
  const board = new MultiBoard([{ id: 'web', board: web }, { id: 'mobile', board: mobile }], 'mobile');
  assert.deepEqual(board.boards.map(item => item.id), ['web', 'mobile']);
  assert.equal((await board.createTask({ title: 'a', description: '', requestId: '1' })).label, 'MOB-1');
  assert.equal((await board.createTask({ title: 'b', description: '', requestId: '2', board: 'web' })).label, 'WEB-1');
  await assert.rejects(() => board.createTask({ title: 'c', description: '', requestId: '3', board: 'billing' }), /Connected boards: web, mobile/);
  const [onWeb] = await board.findAssignees('Dana', 'web');
  assert.match(onWeb!.id, /^web::/);
  await assert.rejects(() => board.createTask({ title: 'd', description: '', requestId: '4', assigneeId: onWeb!.id }), /found on web/);
  assert.equal((await board.createTask({ title: 'd', description: '', requestId: '4', board: 'web', assigneeId: onWeb!.id })).label, 'WEB-2');
  // Searching one board, and a board that cannot answer does not hide the others.
  assert.deepEqual((await board.searchTasks({ board: 'web' })).map(task => task.key).sort(), ['WEB-1', 'WEB-2']);
  assert.equal((await board.searchTasks({})).length, 3);
  assert.equal((await board.getTask('MOB-1'))?.title, 'a');
});

test('several boards: JQL goes only to boards that understand it', async () => {
  const board = new MultiBoard([{ id: 'jira', board: jira() }, { id: 'ops', board: new MemoryBoard('memory', 'OPS', people) }]);
  assert.equal(board.queryLanguage, 'jql');
  await board.createTask({ title: 'on jira', description: '', requestId: 'j1' });
  await board.createTask({ title: 'on ops', description: '', requestId: 'o1', board: 'ops' });
  const found = await board.searchTasks({ jql: 'status = "To Do"' });
  assert.deepEqual(found.map(task => task.key), ['KAN-1']);
});

test('several repositories: paths carry the repository, and evidence comes from each', async () => {
  const code = new MultiCode([{ id: 'shop', code: new MemoryCode('shop', files) },
    { id: 'app', code: new MemoryCode('app', { 'src/retry.ts': 'retry with jitter' }) }]);
  const found = await code.findEvidence('jitter');
  assert.deepEqual(found.map(item => item.path).sort(), ['app/src/retry.ts', 'shop/src/payments/retry.ts']);
  assert.deepEqual(await code.listFiles('app/'), ['app/src/retry.ts']);
  assert.equal(await code.readFile('billing/x.ts'), undefined);
  assert.match((await code.overview()).readme ?? '', /^\(shop\)/);
});
