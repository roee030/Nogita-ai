import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentContent, type ChatModel, type ChatModelResponse } from '../src/core/agent.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { checkCompletion, requestedTaskCount, type GateCall } from '../src/core/completion-gate.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'dana', displayName: 'Dana Katz' }, { id: 'roee', displayName: 'Roee Angel' }]);
const assignable = () => new Map([['lead', 'Lead Person'], ['dana', 'Dana Katz'], ['roee', 'Roee Angel']]);

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
/** Scripted model: each call returns the next step. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(): Promise<ChatModelResponse> {
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = step.text ? [{ type: 'text', text: step.text }] : [];
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

async function turn(request: string, steps: Step[], board = new MemoryBoard('memory', 'MEM', assignable())) {
  const { toolbox } = buildToolbox({ actor: lead, request, sessionId: 's', eventId: 'e1', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new Map(), batchTasks: true,
    onReceipt: async () => undefined });
  const result = await runAgent(new ScriptedModel(steps), { stableSystem: '', turnSystem: '', stream: false, toolbox, request,
    messages: [{ role: 'user', content: request }] });
  return { result, board };
}

const task = (title: string, assignee?: string) => ({ title, description: `About ${title}.`, ...(assignee ? { assignee } : {}) });

test('the requested task count comes from the words, in English and Hebrew', () => {
  assert.equal(requestedTaskCount('open three tasks, two for Dana and one for Roee'), 3);
  assert.equal(requestedTaskCount('Create 5 tickets for the retry work'), 5);
  assert.equal(requestedTaskCount('open two tasks for Dana and one task for Roee'), 3);
  assert.equal(requestedTaskCount('open a task for the flaky test'), 1);
  assert.equal(requestedTaskCount('log tasks for these'), 1);
  assert.equal(requestedTaskCount('פתחי חמש משימות על ה-retry'), 5);
  assert.equal(requestedTaskCount('תפתחי משימה אחת לדנה'), 1);
  assert.equal(requestedTaskCount('נוגיטה, תפתחי שלוש משימות'), 3);
  assert.equal(requestedTaskCount('what tasks are open?'), undefined);
  assert.equal(requestedTaskCount('how many open tasks does Dana have?'), undefined);
  assert.equal(requestedTaskCount('כמה משימות פתוחות יש?'), undefined);
  // A follow-up carries the earlier request on its own line.
  assert.equal(requestedTaskCount('open four tasks for the cache\nyes, go ahead'), 4);
});

test('a turn that created every requested task is complete', async () => {
  const { result, board } = await turn('open three tasks for the retry work', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two'), task('Three')] } }] },
    { text: 'Opened all three.' },
  ]);
  assert.equal(board.tasks.length, 3);
  assert.deepEqual(result.completion, { complete: true, requestedTasks: 3, createdTasks: 3, missing: [] });
});

test('asked for three, the model created two: not complete', async () => {
  const { result } = await turn('open three tasks for the retry work', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two')] } }] },
    { text: 'Opened all three.' },
  ]);
  assert.equal(result.completion.complete, false);
  assert.equal(result.completion.createdTasks, 2);
  assert.deepEqual(result.completion.missing, ['created 2 of 3 requested tasks']);
});

test('a batch item that failed is missing, with its reason', async () => {
  const { result, board } = await turn('open three tasks, one for Moshe', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two', 'Moshe'), task('Three')] } }] },
    { text: 'Done, all three are open.' },
  ]);
  assert.equal(board.tasks.length, 2);
  assert.equal(result.completion.complete, false);
  assert.equal(result.completion.missing.length, 2);
  assert.match(result.completion.missing[0]!, /^create_task \(two\) failed: Not created: /);
  assert.equal(result.completion.missing[1], 'created 2 of 3 requested tasks');
});

test('a failed item retried under the same title is no longer missing', async () => {
  const { result, board } = await turn('open a task for Moshe about the cache', [
    { tools: [{ name: 'create_task', input: task('Cache the board lookups', 'Moshe') }] },
    { tools: [{ name: 'create_task', input: task('Cache the board lookups') }] },
    { text: 'Opened it, unassigned: I could not find Moshe.' },
  ]);
  assert.equal(board.tasks.length, 1);
  assert.deepEqual(result.completion, { complete: true, requestedTasks: 1, createdTasks: 1, missing: [] });
});

test('asked to create a task, the model only asked a question back: not complete', async () => {
  const { result } = await turn('open a task for the flaky test', [{ text: 'Who should own it?' }]);
  assert.equal(result.completion.complete, false);
  assert.deepEqual(result.completion.missing, ['created 0 of 1 requested task']);
});

test('a question with no writes is complete', async () => {
  const { result } = await turn('what changed in the retry worker?', [
    { tools: [{ name: 'search_code', input: { query: 'retry' } }] },
    { text: 'The backoff doubled.' },
  ]);
  assert.deepEqual(result.completion, { complete: true, createdTasks: 0, missing: [] });
});

test('an update that failed is missing; one that was retried and worked is not', async () => {
  const board = new MemoryBoard('memory', 'MEM', assignable());
  await board.createTask({ title: 'Existing', description: '', requestId: 'seed' });
  const { result } = await turn('move MEM-1 and MEM-9 to Done', [
    { tools: [{ name: 'update_tasks', input: { updates: [{ key: 'MEM-1', status: 'Done' }, { key: 'MEM-9', status: 'Done' }] } }] },
    { text: 'Both are done.' },
  ], board);
  assert.equal(result.completion.complete, false);
  assert.equal(result.completion.missing.length, 1);
  assert.match(result.completion.missing[0]!, /^update_task \(MEM-9\) failed: /);

  const retried = checkCompletion('move MEM-2 to Done', [
    { name: 'update_task', input: { key: 'mem-2', status: 'Done' }, outcome: { content: 'Tool failed: 502', isError: true }, write: true },
    { name: 'update_task', input: { key: 'MEM-2', status: 'Done' }, outcome: { content: 'MEM-2 moved to Done: https://x' }, write: true },
  ]);
  assert.deepEqual(retried, { complete: true, createdTasks: 0, missing: [] });
});

test('a batch refused as a whole leaves every item missing', () => {
  const calls: GateCall[] = [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two')] },
    outcome: { content: 'Not created: too many writes in one request.', isError: true }, write: true }];
  const report = checkCompletion('open two tasks', calls);
  assert.equal(report.complete, false);
  assert.equal(report.createdTasks, 0);
  assert.deepEqual(report.missing, ['create_task (one) failed: Not created: too many writes in one request.',
    'create_task (two) failed: Not created: too many writes in one request.', 'created 0 of 2 requested tasks']);
});

test('other writes are checked by their result; reads never count', () => {
  const report = checkCompletion(undefined, [
    { name: 'search_code', input: {}, outcome: { content: 'boom', isError: true }, write: false },
    { name: 'post_message', input: { channel: 'dev' }, outcome: { content: 'Not posted: channel not found', isError: true }, write: true },
  ]);
  assert.deepEqual(report, { complete: false, createdTasks: 0, missing: ['post_message failed: Not posted: channel not found'] });
});

test('without the request, only the tool results are checked', async () => {
  const { toolbox } = buildToolbox({ actor: lead, request: 'open three tasks', sessionId: 's', eventId: 'e1', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board: new MemoryBoard('memory', 'MEM', assignable()),
    completed: new Map(), batchTasks: true, onReceipt: async () => undefined });
  const result = await runAgent(new ScriptedModel([
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two')] } }] }, { text: 'Opened them.' },
  ]), { stableSystem: '', turnSystem: '', stream: false, toolbox, messages: [{ role: 'user', content: 'open three tasks' }] });
  assert.deepEqual(result.completion, { complete: true, createdTasks: 2, missing: [] });
});
