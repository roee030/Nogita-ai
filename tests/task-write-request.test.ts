import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolbox, requestsTaskWrite } from '../src/core/agent-tools.ts';
import { requestedTaskCount } from '../src/core/completion-gate.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';

/** What meeting transcripts actually gave (the 100-case eval), and close variants. */
const NOISY_ASKS = [
  'Nogita open three tusks one for cash invalidation one for jira retries and one for the voice lab read me',
  'Nogita, um, can you open, uh, two tasks, one for the, the cache headers and one for, um, the retry backoff.',
  'Nogita, תפתחי משימה about the Slack token refresh.',
  'נוגיטה, תפתחי שתי משימות על הקאש',
  'open a tusk for the retry worker',
  'can you, uh, log a, a bug for the crash',
  'please create a tiket for the export',
];

/** Must stay refused: questions, talk about tasks, other work, and a misheard noun with no ask. */
const NOT_ASKS = [
  'what are the open, uh, issues?',
  'um, any open tasks for Dana?',
  'did Dana open a, a ticket for that?',
  'what are the tusks on the board?',
  'add tests for the parser',
  'open the, uh, the door please',
  'כמה משימות פתוחות יש?',
  'the tusks are in the backlog',
  'prepare a PR',
];

test('with noisy on, task requests through fillers, a misheard noun or Hebrew pass the explicit-request check', () => {
  for (const text of NOISY_ASKS) {
    assert.equal(requestsTaskWrite(text, { noisy: true }), true, text);
    assert.equal(requestsTaskWrite(text), false, `strict as before: ${text}`);
  }
});

test('with noisy on, questions and other words still do not pass', () => {
  for (const text of NOT_ASKS) assert.equal(requestsTaskWrite(text, { noisy: true }), false, text);
});

test('noisy changes nothing that already passed', () => {
  for (const text of ['open a task for Moshe', 'can you log a bug for this', 'add it to the backlog', 'create tickets for both',
    'and open one for me to write tests for the Slack socket reconnect.', 'write that up'])
    assert.equal(requestsTaskWrite(text, { noisy: true }), true, text);
  // The completion gate's count is untouched (it reads requests itself, strictly).
  assert.equal(requestedTaskCount('open three tusks one for cash'), undefined);
  assert.equal(requestedTaskCount('פתחי חמש משימות'), 5);
});

test('the toolbox lets the "tusks" request create tasks only with the flag', async () => {
  for (const noisyTaskRequests of [true, false]) {
    const board = new DemoBoard();
    const { toolbox } = buildToolbox({ actor: { id: 'roee', displayName: 'Roee', verified: true }, request: NOISY_ASKS[0]!,
      sessionId: 's', eventId: `e-${noisyTaskRequests}`, policy: new AllowlistPolicy(new Set(['roee'])), code: new DemoCode(), board,
      completed: new Map(), onReceipt: async () => undefined, noisyTaskRequests });
    const outcome = await toolbox.run('create_task', { title: 'Cache invalidation', description: 'Asked in the meeting.' });
    assert.equal(board.tasks.length, noisyTaskRequests ? 1 : 0, `noisy=${noisyTaskRequests}: ${outcome.content}`);
  }
});

// P5-15: a yes to her own offer approves exactly that write (live Meet 2026-11-01).
import { NogitaEngine, offeredWrite } from '../src/core/engine.ts';
import { DemoBrain, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

type OfferStep = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
class OfferModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly toolResults: string[] = [];
  private index = 0;
  constructor(private readonly steps: OfferStep[]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const last = request.messages.at(-1);
    if (last && Array.isArray(last.content)) {
      for (const item of last.content) if (item.type === 'tool_result') this.toolResults.push(String(item.content));
    }
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) { onText(step.text); content.push({ type: 'text', text: step.text }); }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const MEET_OFFER = "Oh, I didn't create any jira tasks. My last attempt was rejected, so nothing was written to the board. Want me to try again with one task covering today's merged PRs?";

function offerFixture(steps: OfferStep[], offerApproval: boolean) {
  const model = new OfferModel(steps);
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])),
    agent: model, people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, offerApproval, batchTasks: true });
  const utter = (text: string, eventId: string) => engine.onUtterance('s', { text, eventId, actor: roee });
  return { engine, board, model, utter, meeting: new DemoMeeting('m') };
}

test('offeredWrite reads the offer from the Meet, its count, and offers without a task', () => {
  assert.deepEqual(offeredWrite(MEET_OFFER), { request: "create one task covering today's merged PRs", tasks: 1 });
  assert.equal(requestsTaskWrite(offeredWrite(MEET_OFFER)!.request), true);
  assert.deepEqual(offeredWrite('Want me to open two tasks, one per bug?'), { request: 'open two tasks, one per bug', tasks: 2 });
  assert.equal(offeredWrite('Do you want me to open a Jira task for each one?')!.tasks, undefined);
  assert.equal(offeredWrite('Want me to read the file?'), undefined);
  assert.equal(offeredWrite('Which PRs do you mean?'), undefined);
});

test('"Yeah, do it" to her offer of one task opens it (live Meet 2026-11-01)', async () => {
  const f = offerFixture([
    { text: MEET_OFFER },
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: '36 PRs merged today' } }] },
    { text: 'Done.' },
  ], true);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, did you create all the tasks in jira?', '1');
  await f.utter('Yeah, do it.', '2');
  assert.equal(f.board.tasks.length, 1);
});

test('without NOGITA_OFFER_APPROVAL the same yes stays refused, as in the Meet', async () => {
  const f = offerFixture([
    { text: MEET_OFFER },
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: 'd' } }] },
    { text: 'Blocked.' },
  ], false);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, did you create all the tasks in jira?', '1');
  await f.utter('Yeah, do it.', '2');
  assert.equal(f.board.tasks.length, 0);
});

test('a yes to one offered task does not approve several', async () => {
  const f = offerFixture([
    { text: MEET_OFFER },
    { tools: [{ name: 'create_task', input: { title: 'PR 70', description: 'd' } }, { name: 'create_task', input: { title: 'PR 71', description: 'd' } }] },
    { text: 'Hm.' },
  ], true);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, did you create all the tasks in jira?', '1');
  await f.utter('Yeah, do it.', '2');
  assert.equal(f.board.tasks.length, 1);
  assert.match(f.model.toolResults.join('\n'), /said yes to 1 task\(s\) you offered/);
});

const task = (n: number) => ({ title: `PR ${n}`, description: 'd' });
const VAGUE_OFFER = 'Want me to open tasks for those PRs?';

test('a yes to an offer with no number does not open a batch: she has to say how many first', async () => {
  const f = offerFixture([
    { text: VAGUE_OFFER },
    { tools: [{ name: 'create_tasks', input: { tasks: [1, 2, 3, 4, 5, 6].map(task) } }] },
    { text: 'That would be six tasks, one per PR. Should I open six tasks?' },
    { tools: [{ name: 'create_tasks', input: { tasks: [1, 2, 3, 4, 5, 6].map(task) } }] },
    { text: 'Done.' },
  ], true);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, what did we merge today?', '1');
  await f.utter('Yeah, do it.', '2');
  assert.equal(f.board.tasks.length, 0);
  assert.match(f.model.toolResults.join(' '), /named no number/);
  await f.utter('Yes.', '3');
  assert.equal(f.board.tasks.length, 6);
});

test('a yes to an offer with no number still opens a few, one at a time or together', async () => {
  const f = offerFixture([
    { text: 'Do you want me to open a Jira task for each one?' },
    { tools: [{ name: 'create_tasks', input: { tasks: [1, 2, 3].map(task) } }] },
    { tools: [{ name: 'create_task', input: task(4) }] },
    { text: 'Three are open.' },
  ], true);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, which PRs are blocked?', '1');
  await f.utter('Yes, please.', '2');
  assert.equal(f.board.tasks.length, 3);
});

test('a bare yes with no offer before it opens nothing', async () => {
  const f = offerFixture([
    { text: 'Yes, 36 PRs were merged today.' },
    { tools: [{ name: 'create_task', input: { title: 'x', description: 'd' } }] },
    { text: 'Blocked.' },
  ], true);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, did we push to main today?', '1');
  await f.utter('Yeah, do it.', '2');
  assert.equal(f.board.tasks.length, 0);
});

test('"turn them into Jira tasks" reads as a request only with the flag', () => {
  for (const text of ['Turn them into Jira tasks.', "Combine today's PRs into one task.", 'Can you turn those into tickets?',
    'convert the action items into tasks']) {
    assert.equal(requestsTaskWrite(text, { into: true }), true, text);
    assert.equal(requestsTaskWrite(text), false, text);
  }
  for (const text of ['How do we turn PRs into tasks?', 'What did we merge into main today?', 'combine the two PRs into one branch'])
    assert.equal(requestsTaskWrite(text, { into: true }), false, text);
});
