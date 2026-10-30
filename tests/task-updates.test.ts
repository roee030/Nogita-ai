import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolbox, requestedTaskChanges } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { ActionReceipt } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'dana', displayName: 'Dana Katz' }]);

test('task changes need their own words in the request', () => {
  const none = { status: false, assignee: false, comment: false };
  assert.deepEqual(requestedTaskChanges("what's the status of KAN-12?"), none);
  assert.deepEqual(requestedTaskChanges('who is KAN-12 assigned to?'), none);
  assert.deepEqual(requestedTaskChanges("let's move on to the next topic"), none);
  assert.deepEqual(requestedTaskChanges('move KAN-12 to done'), { ...none, status: true });
  assert.deepEqual(requestedTaskChanges('mark it as done'), { ...none, status: true });
  assert.deepEqual(requestedTaskChanges('close that ticket'), { ...none, status: true });
  assert.deepEqual(requestedTaskChanges('reopen KAN-3'), { ...none, status: true });
  assert.deepEqual(requestedTaskChanges('assign KAN-4 to Dana'), { ...none, assignee: true });
  assert.deepEqual(requestedTaskChanges('can you reassign it to me'), { ...none, assignee: true });
  assert.deepEqual(requestedTaskChanges('add a comment that the fix is in review'), { ...none, comment: true });
  assert.deepEqual(requestedTaskChanges('move the login bug to in progress and give it to Dana'), { ...none, status: true, assignee: true });
});

test('update_task changes only what was asked, resolves the owner, and posts the link once', async () => {
  const board = new MemoryBoard('memory', 'MEM', new Map([['lead', 'Lead Person'], ['dana', 'Dana Katz']]));
  const created = await board.createTask({ title: 'Fix login', description: 'Users get logged out', requestId: 'c1' });
  const receipts: ActionReceipt[] = [];
  const completed = new Map<string, ActionReceipt>();
  const make = (request: string, eventId = 'e1') => buildToolbox({ actor: lead, request, sessionId: 's', eventId, people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed,
    onReceipt: async receipt => { receipts.push(receipt); } }).toolbox;

  const question = await make("what's the status of MEM-1?").run('update_task', { key: created.label, status: 'Done' });
  assert.equal(question.isError, true);
  const sneaky = await make('move MEM-1 to in progress').run('update_task', { key: created.label, status: 'In Progress', comment: 'Ship it' });
  assert.equal(sneaky.isError, true);
  assert.match(sneaky.content, /a comment/);
  assert.equal(board.tasks[0]!.status, 'To Do');

  const toolbox = make('move MEM-1 to in progress and assign it to Dana');
  const moved = await toolbox.run('update_task', { key: 'mem-1', status: 'In Progress', assignee: 'Dana' });
  assert.equal(moved.isError, undefined);
  assert.match(moved.content, /MEM-1 moved to In Progress, assigned to Dana Katz/);
  await toolbox.run('update_task', { key: 'mem-1', status: 'In Progress', assignee: 'Dana' });
  assert.equal(board.tasks[0]!.status, 'In Progress');
  assert.equal(board.tasks[0]!.assigneeId, 'dana');
  assert.equal(receipts.length, 1);

  const unknown = await make('assign MEM-1 to Avi', 'e2').run('update_task', { key: 'MEM-1', assignee: 'Avi' });
  assert.equal(unknown.isError, true);
  assert.equal(board.tasks[0]!.assigneeId, 'dana');
});

test('update_task is offered only to authorized speakers and only where the board supports it', () => {
  const tools = (actorId: string, board = new MemoryBoard()) => buildToolbox({ actor: { ...lead, id: actorId }, request: 'close KAN-1',
    sessionId: 's', eventId: 'e', policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new Map(),
    onReceipt: async () => undefined }).toolbox.specs.map(spec => spec.name);
  assert.ok(tools('lead').includes('update_task'));
  assert.ok(!tools('guest').includes('update_task'));
  const readOnly = Object.assign(new MemoryBoard(), { updateTask: undefined });
  assert.ok(!tools('lead', readOnly).includes('update_task'));
});
