import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelWriteIntentJudge, parseVerdict, type WriteIntentCheck, type WriteIntentJudge, type WriteIntentVerdict } from '../src/core/write-intent.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const guest = { id: 'guest', displayName: 'Guest', verified: false };

class FakeJudge implements WriteIntentJudge {
  readonly checks: WriteIntentCheck[] = [];
  constructor(private readonly answer: WriteIntentVerdict | Error) {}
  async judge(check: WriteIntentCheck): Promise<WriteIntentVerdict> {
    this.checks.push(check);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function toolbox(request: string, judge?: WriteIntentJudge, actor = roee, board: DemoBoard | MemoryBoard = new DemoBoard()) {
  const built = buildToolbox({ actor, request, sessionId: 's', eventId: 'e', policy: new AllowlistPolicy(new Set(['roee'])),
    code: new DemoCode(), board, completed: new Map(), onReceipt: async () => undefined, batchTasks: true,
    ...(judge ? { writeIntent: judge, lastMessage: "Want me to open one task covering today's merged PRs?" } : {}) });
  return { board, ...built };
}

test('parseVerdict reads the three answers and fails closed on anything else', () => {
  assert.deepEqual(parseVerdict('{"verdict":"asked"}'), { verdict: 'asked' });
  assert.deepEqual(parseVerdict('Sure: {"verdict":"not_asked"}'), { verdict: 'not_asked' });
  assert.deepEqual(parseVerdict('{"verdict":"unclear","confirm":"Want me to open one task for the 36 PRs?"}'),
    { verdict: 'unclear', confirm: 'Want me to open one task for the 36 PRs?' });
  // The question is made an offer, so the yes after it is read as one (NOGITA_OFFER_APPROVAL).
  assert.deepEqual(parseVerdict('{"verdict":"unclear","confirm":"Open one task for the 36 PRs."}'),
    { verdict: 'unclear', confirm: 'Want me to open one task for the 36 PRs?' });
  for (const text of ['', 'asked', '{"verdict":"yes"}', '{"verdict":"unclear"}', '{broken'])
    assert.deepEqual(parseVerdict(text), { verdict: 'not_asked' }, text);
});

test('the model judge fails closed when the model errors', async () => {
  const failing: ChatModel = { agentModel: 'x', streamChat: async () => { throw new Error('down'); } };
  const verdict = await new ModelWriteIntentJudge(failing).judge({ kind: 'create_task', proposed: 'create 1 task: x', request: 'y', speaker: 'Roee' });
  assert.deepEqual(verdict, { verdict: 'not_asked' });
});

test('a phrased request never asks the judge (the fast path)', async () => {
  const judge = new FakeJudge({ verdict: 'not_asked' });
  const { toolbox: box, board } = toolbox('Nogita, open a task for the cache headers.', judge);
  const result = await box.run('create_task', { title: 'Cache headers', description: 'd' });
  assert.equal(result.isError, undefined);
  assert.equal(board.tasks.length, 1);
  assert.equal(judge.checks.length, 0);
});

test('the Meet\'s words that no phrase matched: the judge decides, and sees the exact write', async () => {
  const request = 'All the PR that we pushed today. You need to combine them.\nYou need to combine. Part of the task to tasks in in jira.';
  const asked = toolbox(request, new FakeJudge({ verdict: 'asked' }));
  assert.equal((await asked.toolbox.run('create_task', { title: "Today's merged PRs", description: 'd' })).isError, undefined);
  assert.equal(asked.board.tasks.length, 1);

  const judge = new FakeJudge({ verdict: 'unclear', confirm: 'Want me to open one task for the 36 PRs?' });
  const unclear = toolbox(request, judge);
  const result = await unclear.toolbox.run('create_task', { title: "Today's merged PRs", description: 'd' });
  assert.equal(result.isError, true);
  assert.match(result.content, /Ask exactly this one short question.*"Want me to open one task for the 36 PRs\?"/);
  assert.equal(unclear.board.tasks.length, 0);
  assert.deepEqual(judge.checks[0], { kind: 'create_task', proposed: "create 1 task: Today's merged PRs", request, speaker: 'Roee Angel',
    lastMessage: "Want me to open one task covering today's merged PRs?" });
});

test('not asked, or a judge that fails: nothing is written', async () => {
  for (const answer of [{ verdict: 'not_asked' } as const, new Error('timeout')]) {
    const { toolbox: box, board } = toolbox('What are the open tasks?', new FakeJudge(answer));
    const result = await box.run('create_task', { title: 'x', description: 'd' });
    assert.equal(result.isError, true);
    assert.match(result.content, /does not explicitly ask/);
    assert.equal(board.tasks.length, 0);
  }
});

test('every write tool goes through the judge, with what it would write', async () => {
  const judge = new FakeJudge({ verdict: 'not_asked' });
  const { toolbox: box } = toolbox('hmm, the export thing again', judge, roee, new MemoryBoard());
  await box.run('create_tasks', { tasks: [{ title: 'A', description: 'd' }, { title: 'B', description: 'd' }] });
  await box.run('update_task', { key: 'KAN-1', status: 'Done' });
  await box.run('update_tasks', { updates: [{ key: 'KAN-1', comment: 'shipped' }] });
  assert.deepEqual(judge.checks.map(check => [check.kind, check.proposed]), [
    ['create_task', 'create 2 tasks: A; B'],
    ['update_task', 'KAN-1: status Done'],
    ['update_task', 'KAN-1: comment "shipped"'],
  ]);
});

test('a speaker who may not write gets no write tools, whatever the judge would say', () => {
  const { toolbox: box } = toolbox('Open a task for the export.', new FakeJudge({ verdict: 'asked' }), guest);
  const names = box.specs.map(spec => spec.name);
  for (const name of ['create_task', 'create_tasks', 'update_task', 'update_tasks']) assert.equal(names.includes(name), false, name);
});

// End to end through the engine: the judge is the same model, so its answers sit between the agent's steps.
type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
class Scripted implements ChatModel {
  readonly agentModel = 'scripted';
  readonly judged: string[] = [];
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.usageContext === 'write_intent') this.judged.push(String(request.messages[0]!.content));
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) { onText(step.text); content.push({ type: 'text', text: step.text }); }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

function engineWith(steps: Step[], flags: { writeIntent: boolean; offerApproval?: boolean }) {
  const model = new Scripted(steps);
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])),
    agent: model, people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, ...flags });
  return { engine, board, model, meeting: new DemoMeeting('m'),
    utter: (text: string, eventId: string) => engine.onUtterance('s', { text, eventId, actor: roee }) };
}

test('NOGITA_WRITE_INTENT: the misheard Meet request opens the task the judge found asked for', async () => {
  const f = engineWith([
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: '36 PRs' } }] },
    { text: '{"verdict":"asked"}' },
    { text: 'Done, it is KAN-7.' },
  ], { writeIntent: true });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, you need to combine. Part of the task to tasks in in jira.', '1');
  assert.equal(f.board.tasks.length, 1);
  assert.match(f.model.judged[0]!, /Proposed write \(creating board task\(s\)\): create 1 task: Today's merged PRs/);
});

test('unclear, then her one question, then "yes": exactly the task she asked about is opened', async () => {
  const f = engineWith([
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: 'd' } }] },
    { text: '{"verdict":"unclear","confirm":"Want me to open one task for the 36 PRs?"}' },
    { text: 'Want me to open one task for the 36 PRs?' },
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: 'd' } }] },
    { text: 'Done.' },
  ], { writeIntent: true, offerApproval: true });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, all the PRs we pushed today, you need to combine them.', '1');
  assert.equal(f.board.tasks.length, 0);
  await f.utter('Yes.', '2');
  assert.equal(f.board.tasks.length, 1);
});

test('with the flag off the same words stay refused and no judge is asked', async () => {
  const f = engineWith([
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: 'd' } }] },
    { text: 'I could not open it.' },
  ], { writeIntent: false });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, you need to combine. Part of the task to tasks in in jira.', '1');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.model.judged.length, 0);
});
