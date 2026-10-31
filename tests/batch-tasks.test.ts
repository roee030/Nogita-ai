import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolbox, combineReceipts } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { ActionReceipt, CreateTask } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'dana', displayName: 'Dana Katz' }, { id: 'roee', displayName: 'Roee Angel' }]);
const assignable = () => new Map([['lead', 'Lead Person'], ['dana', 'Dana Katz'], ['roee', 'Roee Angel']]);

function setup(request: string, options: { board?: MemoryBoard; completed?: Map<string, ActionReceipt>; eventId?: string; batchTasks?: boolean } = {}) {
  const board = options.board ?? new MemoryBoard('memory', 'MEM', assignable());
  const receipts: ActionReceipt[] = [];
  const { toolbox, report } = buildToolbox({ actor: lead, request, sessionId: 's', eventId: options.eventId ?? 'e1', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: options.completed ?? new Map(),
    batchTasks: options.batchTasks ?? true, onReceipt: async receipt => { receipts.push(receipt); } });
  return { toolbox, report, board, receipts };
}

const three = [
  { title: 'Cache the board lookups', description: 'Repeated reads are slow.', assignee: 'Dana' },
  { title: 'Retry Jira writes', description: 'Transient 502s drop tasks.', assignee: 'Dana' },
  { title: 'Document the batch tools', description: 'For the team wiki.', assignee: 'Roee' },
];

test('the batch tools are off unless the team turned them on', () => {
  const names = (batchTasks: boolean) => setup('open three tasks', { batchTasks }).toolbox.specs.map(spec => spec.name);
  assert.ok(!names(false).includes('create_tasks'));
  assert.ok(!names(false).includes('update_tasks'));
  assert.ok(names(false).includes('create_task'));
  assert.ok(names(true).includes('create_tasks'));
  assert.ok(names(true).includes('update_tasks'));
  assert.equal(setup('open three tasks').toolbox.isWrite('create_tasks'), true);
});

test('create_tasks writes every item in order, assigns owners, and posts one chat receipt', async () => {
  const { toolbox, board, receipts, report } = setup('open three tasks, two for Dana and one for Roee');
  const result = await toolbox.run('create_tasks', { tasks: three });
  assert.equal(result.isError, undefined);
  assert.deepEqual(board.tasks.map(task => [task.key, task.title, task.assigneeId]), [
    ['MEM-1', 'Cache the board lookups', 'dana'], ['MEM-2', 'Retry Jira writes', 'dana'], ['MEM-3', 'Document the batch tools', 'roee']]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.label, 'MEM-1, MEM-2 and MEM-3');
  assert.equal(receipts[0]!.url.split(' ').length, 3);
  assert.equal(report.receipts.length, 3);
  assert.match(result.content, /1\. Created MEM-1, assigned to Dana Katz/);
  assert.match(result.content, /3 of 3 created\./);
});

test('create_tasks checks permission once, for the whole batch', async () => {
  const question = setup('what tasks are open?');
  const result = await question.toolbox.run('create_tasks', { tasks: three });
  assert.equal(result.isError, true);
  assert.equal(question.board.tasks.length, 0);

  const outsider = buildToolbox({ actor: { id: 'guest', displayName: 'Guest', verified: false }, request: 'open three tasks', sessionId: 's',
    eventId: 'e', people, policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board: new MemoryBoard(), completed: new Map(),
    batchTasks: true, onReceipt: async () => {} }).toolbox;
  assert.ok(!outsider.specs.some(spec => spec.name === 'create_tasks'));
});

test('one item that fails does not stop the others, and the result says which one', async () => {
  const { toolbox, board, receipts } = setup('open three tasks');
  const result = await toolbox.run('create_tasks', { tasks: [three[0], { ...three[1], assignee: 'Avi' }, three[2]] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(board.tasks.map(task => task.title), ['Cache the board lookups', 'Document the batch tools']);
  assert.match(result.content, /2\. Not created: I could not find anyone named "Avi"/);
  assert.match(result.content, /2 of 3 created\. .*Say which ones were not/);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.label, 'MEM-1 and MEM-2');
});

test('a board error on one item is reported and the next item still runs', async () => {
  class FlakyBoard extends MemoryBoard {
    override async createTask(input: CreateTask): Promise<ActionReceipt> {
      if (input.title.startsWith('Retry')) throw new Error('Jira answered 502');
      return super.createTask(input);
    }
  }
  const { toolbox, board } = setup('open three tasks', { board: new FlakyBoard('memory', 'MEM', assignable()) });
  const result = await toolbox.run('create_tasks', { tasks: three });
  assert.equal(board.tasks.length, 2);
  assert.match(result.content, /2\. Not created: Jira answered 502/);
});

test('every item has its own idempotency key, so a retried event creates nothing twice', async () => {
  const board = new MemoryBoard('memory', 'MEM', assignable());
  const completed = new Map<string, ActionReceipt>();
  const first = setup('open three tasks', { board, completed });
  await first.toolbox.run('create_tasks', { tasks: three });
  // The retry reworded one title; the n-th task of the event still maps to the same issue.
  const retry = setup('open three tasks', { board, completed });
  const result = await retry.toolbox.run('create_tasks', { tasks: [three[0], { ...three[1], title: 'Retry the Jira writes' }, three[2]] });
  assert.equal(board.tasks.length, 3);
  assert.equal(retry.receipts.length, 0);
  assert.match(result.content, /3 of 3 created/);
  assert.equal(new Set(completed.keys()).size, 3);

  // Even with the in-memory map gone (a restart), the board's own request keys stop a second write.
  const restarted = setup('open three tasks', { board });
  await restarted.toolbox.run('create_tasks', { tasks: three });
  assert.equal(board.tasks.length, 3);
});

test('a batch holds at most ten items and rejects bad input before writing anything', async () => {
  const { toolbox, board } = setup('open eleven tasks');
  const eleven = Array.from({ length: 11 }, (_, index) => ({ title: `Task ${index + 1}`, description: 'x' }));
  const tooMany = await toolbox.run('create_tasks', { tasks: eleven });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content, /at most 10/);
  assert.equal((await toolbox.run('create_tasks', { tasks: [] })).isError, true);
  assert.equal((await toolbox.run('create_tasks', { tasks: ['a title'] })).isError, true);
  assert.equal(board.tasks.length, 0);

  const ten = await toolbox.run('create_tasks', { tasks: eleven.slice(0, 10) });
  assert.match(ten.content, /10 of 10 created/);
  assert.equal(board.tasks.length, 10);
});

test('a batch where nothing was written is an error', async () => {
  const { toolbox, receipts } = setup('open two tasks');
  const result = await toolbox.run('create_tasks', { tasks: [{ title: '', description: 'x' }, { title: 'Owner', description: 'x', assignee: 'Avi' }] });
  assert.equal(result.isError, true);
  assert.match(result.content, /0 of 2 created\./);
  assert.equal(receipts.length, 0);
});

test('update_tasks changes several tasks with one check of what was asked, and one receipt', async () => {
  const board = new MemoryBoard('memory', 'MEM', assignable());
  for (const title of ['Login', 'Search', 'Export']) await board.createTask({ title, description: '', requestId: title });

  const sneaky = setup('move MEM-1 and MEM-2 to done', { board });
  const refused = await sneaky.toolbox.run('update_tasks', { updates: [{ key: 'MEM-1', status: 'Done' }, { key: 'MEM-2', status: 'Done', comment: 'Shipped' }] });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /a comment/);
  assert.deepEqual(board.tasks.map(task => task.status), ['To Do', 'To Do', 'To Do']);

  const { toolbox, receipts } = setup('move MEM-1 and MEM-2 to done and assign MEM-3 to Dana', { board });
  const result = await toolbox.run('update_tasks', { updates: [{ key: 'mem-1', status: 'Done' }, { key: 'MEM-2', status: 'Done' }, { key: 'MEM-3', assignee: 'Dana' }] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(board.tasks.map(task => [task.status, task.assigneeId]), [['Done', undefined], ['Done', undefined], ['To Do', 'dana']]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.label, 'MEM-1, MEM-2 and MEM-3');
  assert.match(result.content, /3 of 3 changed/);

  // The same updates again in the same event change nothing and post nothing.
  await toolbox.run('update_tasks', { updates: [{ key: 'MEM-1', status: 'Done' }] });
  assert.equal(receipts.length, 1);
});

test('update_tasks reports a missing task and still changes the rest', async () => {
  const board = new MemoryBoard('memory', 'MEM', assignable());
  await board.createTask({ title: 'Login', description: '', requestId: 'r1' });
  const { toolbox } = setup('close MEM-1 and MEM-9', { board });
  const result = await toolbox.run('update_tasks', { updates: [{ key: 'MEM-9', status: 'Done' }, { key: 'MEM-1', status: 'Done' }] });
  assert.equal(board.tasks[0]!.status, 'Done');
  assert.match(result.content, /1\. Not changed: MEM-9 was not found/);
  assert.match(result.content, /1 of 2 changed/);
});

test('combineReceipts keeps a single receipt as it is', () => {
  const one = { provider: 'p', kind: 'task' as const, label: 'MEM-1', url: 'https://x/1' };
  assert.equal(combineReceipts([one]), one);
  assert.deepEqual(combineReceipts([one, { ...one, label: 'MEM-2', url: 'https://x/2' }]),
    { provider: 'p', kind: 'task', label: 'MEM-1 and MEM-2', url: 'https://x/1 https://x/2' });
});
