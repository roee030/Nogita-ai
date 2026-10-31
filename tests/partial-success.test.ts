import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, shortfallLine, type AgentContent, type AgentTurn, type ChatModel, type ChatModelRequest,
  type ChatModelResponse } from '../src/core/agent.ts';
import { stableAgentPrompt } from '../src/core/agent-prompt.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'dana', displayName: 'Dana Katz' }]);
const assignable = () => new Map([['lead', 'Lead Person'], ['dana', 'Dana Katz']]);

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }>; stopReason?: string; ms?: number };
/** Scripted model that records every request; a step may advance the clock to spend the turn's time. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[], private readonly clock = { t: 0 }) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    this.requests.push({ ...request, messages: request.messages.slice() });
    const step = this.steps[this.index++] ?? { text: '' };
    this.clock.t += step.ms ?? 0;
    const content: AgentContent[] = step.text ? [{ type: 'text', text: step.text }] : [];
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.stopReason ?? (step.tools?.length ? 'tool_use' : 'end_turn') };
  }
}

async function turn(request: string, steps: Step[], options: Partial<AgentTurn> = {}) {
  const board = new MemoryBoard('memory', 'MEM', assignable());
  const { toolbox } = buildToolbox({ actor: lead, request, sessionId: 's', eventId: 'e1', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new Map(), batchTasks: true,
    onReceipt: async () => undefined });
  const clock = { t: 0 };
  const model = new ScriptedModel(steps, clock);
  const spoken: string[] = [];
  const result = await runAgent(model, { stableSystem: '', turnSystem: '', stream: false, toolbox, request,
    messages: [{ role: 'user', content: request }], now: () => clock.t, onSpeech: text => spoken.push(text), ...options });
  return { result, board, model, spoken };
}

const task = (title: string, assignee?: string) => ({ title, description: `About ${title}.`, ...(assignee ? { assignee } : {}) });
const noteOf = (request: ChatModelRequest) => {
  const last = request.messages.at(-1)!.content;
  return typeof last === 'string' ? '' : last.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
};

test('after a batch with a failed item, the model is told what is still missing', async () => {
  const { result, board, model } = await turn('open three tasks, one for Moshe', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two', 'Moshe'), task('Three')] } }] },
    { text: "I opened two of the three; the third didn't go through because there's no user named Moshe." },
  ], { honestShortfall: true });
  assert.equal(board.tasks.length, 2);
  const note = noteOf(model.requests[1]!);
  assert.match(note, /^Not done yet: create_task \(two\) failed: Not created: .*; created 2 of 3 requested tasks\. /);
  assert.match(note, /Do not redo what already succeeded/);
  // The model's own answer stands; the turn is still not marked a success.
  assert.match(result.answer, /two of the three/);
  assert.equal(result.completion.complete, false);
  assert.equal(result.interrupted, undefined);
});

test('a write step with nothing missing adds no note', async () => {
  const { model } = await turn('open two tasks for the cache', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two')] } }] },
    { text: 'Opened both.' },
  ], { honestShortfall: true });
  assert.equal(noteOf(model.requests[1]!), '');
});

test('a lookup step adds no note even before anything was created', async () => {
  const { model } = await turn('open a task for the retry bug', [
    { tools: [{ name: 'search_code', input: { query: 'retry' } }] },
    { tools: [{ name: 'create_task', input: task('Fix retry') }] },
    { text: 'Opened it.' },
  ], { honestShortfall: true });
  assert.equal(noteOf(model.requests[1]!), '');
});

test('the flag is off by default: no note, no closing line', async () => {
  const { model, result } = await turn('open three tasks, one for Moshe', [
    { tools: [{ name: 'create_tasks', input: { tasks: [task('One'), task('Two', 'Moshe'), task('Three')] } }] },
    { text: 'Done.' },
  ]);
  assert.equal(noteOf(model.requests[1]!), '');
  assert.equal(result.answer, 'Done.');
  assert.doesNotMatch(model.requests[1]!.turnSystem, /offer to finish/);
});

test('out of time after two of three tasks: the turn says so and offers to finish', async () => {
  const { result, board, spoken } = await turn('open three tasks for the retry work', [
    { tools: [{ name: 'create_task', input: task('One') }] },
    { tools: [{ name: 'create_task', input: task('Two') }], ms: 59_000 },
  ], { honestShortfall: true });
  assert.equal(board.tasks.length, 2);
  assert.equal(result.interrupted, 'deadline');
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.answer, 'I opened 2 of the 3 tasks, then ran out of time before the rest. Want me to finish them?');
  assert.equal(spoken.at(-1), result.answer);
  assert.equal(result.completion.complete, false);
});

test('out of time without the flag: interrupted is reported, the answer is unchanged', async () => {
  const { result, spoken } = await turn('what changed in the retry worker?', [
    { tools: [{ name: 'search_code', input: { query: 'retry' } }], ms: 59_000 },
  ]);
  assert.equal(result.interrupted, 'deadline');
  assert.equal(result.answer, '');
  assert.deepEqual(spoken, []);
});

test('a tool call still cut off after the retry: the lead-in is kept and the rest is owned up to', async () => {
  const cut: Step = { text: 'Sure, opening those.', tools: [{ name: 'create_task', input: { title: 'Par' } }], stopReason: 'max_tokens' };
  const { result, board } = await turn('open a task for the cache', [cut, cut], { honestShortfall: true });
  assert.equal(board.tasks.length, 0);
  assert.equal(result.interrupted, 'cut_off');
  assert.equal(result.answer, 'Sure, opening those. Sorry, I got cut off before I could finish that. Want me to keep going?');
});

test('the last step is told to say what is not done', async () => {
  const { model } = await turn('open a task for the cache', [
    { tools: [{ name: 'search_code', input: { query: 'cache' } }] },
    { text: 'I could not open it.' },
  ], { honestShortfall: true, maxSteps: 2 });
  assert.match(model.requests[1]!.turnSystem, /last step: .* If something they asked for is not done, say what, and offer to finish it\.$/);
});

test('the closing line names what got done', () => {
  const write = (isError: boolean) => ({ name: 'post_message', input: {}, outcome: { content: '', isError }, write: true });
  const report = { complete: false, createdTasks: 0, missing: ['x'] };
  assert.equal(shortfallLine(report, [write(false)], 'deadline'), 'I got part of it done, then ran out of time before the rest. Want me to keep going?');
  assert.equal(shortfallLine(report, [write(true)], 'deadline'), 'Sorry, I ran out of time before I could finish that. Want me to keep going?');
  assert.equal(shortfallLine({ ...report, requestedTasks: 5, createdTasks: 3 }, [], 'cut_off'),
    'I opened 3 of the 5 tasks, then got cut off before the rest. Want me to finish them?');
});

test('the partial-success prompt rule is there only when asked for', () => {
  assert.match(stableAgentPrompt({ voice: true, partialSuccess: true }), /When only part of what they asked for worked, say exactly that/);
  assert.doesNotMatch(stableAgentPrompt({ voice: true }), /When only part of what they asked for worked/);
});
