import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, ProviderHealth, ProviderUnavailableError, guardPort } from '../src/core/provider-health.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { guardProviders, providerBreakers } from '../src/app/config.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import type { BoardPort, TaskSummary } from '../src/core/contracts.ts';

const down = () => Promise.reject(new Error('ECONNRESET'));
const fails = async (breaker: CircuitBreaker, times: number) => { for (let i = 0; i < times; i++) await breaker.run(down).catch(() => undefined); };

test('three failures in a row take a provider down; calls then fail at once without reaching it', async () => {
  let now = 0;
  const breaker = new CircuitBreaker('jira', 'Jira', { now: () => now });
  await fails(breaker, 2);
  assert.equal(breaker.state, 'closed');
  await fails(breaker, 1);
  assert.equal(breaker.state, 'open');
  let reached = 0;
  now = 5_000;
  const error = await breaker.run(async () => { reached++; return 'x'; }).catch(e => e);
  assert.ok(error instanceof ProviderUnavailableError);
  assert.match(error.message, /Jira is not answering right now \(down for 5 s\).*not retried/);
  assert.equal(error.spoken, 'Sorry, Jira isn’t answering right now. Try me again in a minute.');
  assert.equal(reached, 0);
});

test('after the cooldown one trial call goes through: it works and the provider is back, or it fails and stays down', async () => {
  let now = 0;
  const changes: string[] = [];
  const breaker = new CircuitBreaker('slack', 'Slack', { now: () => now, cooldownMs: 30_000 }, (_p, state) => changes.push(state));
  await fails(breaker, 3);
  now = 30_000;
  assert.equal(breaker.state, 'half_open');
  // While the trial runs, other calls are still refused.
  let finish!: (value: string) => void;
  const trial = breaker.run(() => new Promise<string>(resolve => { finish = resolve; }));
  await assert.rejects(breaker.run(async () => 'second'), ProviderUnavailableError);
  finish('ok');
  assert.equal(await trial, 'ok');
  assert.equal(breaker.state, 'closed');
  await fails(breaker, 3);
  now = 60_000;
  await breaker.run(down).catch(() => undefined);
  assert.equal(breaker.state, 'open', 'a failed trial keeps it down for another cooldown');
  assert.deepEqual(changes, ['open', 'closed', 'open', 'open']);
});

test('a refused request (4xx), an abort or a rate limit counts right; a slow call counts as a failure', async () => {
  let now = 0;
  const breaker = new CircuitBreaker('github', 'GitHub', { now: () => now, slowMs: 1_000 });
  const status = (code: number) => () => Promise.reject(Object.assign(new Error(`HTTP ${code}`), { status: code }));
  for (let i = 0; i < 5; i++) await breaker.run(status(404)).catch(() => undefined);
  await breaker.run(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))).catch(() => undefined);
  assert.equal(breaker.state, 'closed', 'the provider answered; the request was the problem');
  for (let i = 0; i < 3; i++) await breaker.run(async () => { now += 2_000; return 'late'; });
  assert.equal(breaker.state, 'open', 'three slow calls');
  const limited = new CircuitBreaker('anthropic', 'my AI service');
  for (let i = 0; i < 3; i++) await limited.run(status(429)).catch(() => undefined);
  assert.equal(limited.state, 'open');
});

test('a tool on a provider that is down tells the model so in its result, and the provider is not called again', async () => {
  let calls = 0;
  const board: BoardPort = Object.assign(new DemoBoard(), { async searchTasks(): Promise<TaskSummary[]> { calls++; throw new Error('Jira 503'); } });
  const guarded = guardPort(board, new ProviderHealth().breaker('jira', 'Jira'), ['searchTasks', 'getTask', 'createTask']);
  const { toolbox } = buildToolbox({ actor: { id: 'roee', displayName: 'Roee', verified: true }, request: 'what is open?', sessionId: 's', eventId: 'e',
    policy: new AllowlistPolicy(new Set(['roee'])), code: new DemoCode(), board: guarded, completed: new Map(), onReceipt: async () => undefined });
  const results = [];
  // As the agent loop does: a tool that throws becomes an error result the model reads.
  for (let i = 0; i < 5; i++) results.push(await toolbox.run('search_tasks', { query: 'open' })
    .catch((error: Error) => ({ content: `Tool failed: ${error.message}`, isError: true })));
  assert.equal(calls, 3);
  assert.match(results.at(-1)!.content, /Jira is not answering right now/);
  assert.ok(results.every(result => result.isError));
});

/** An Anthropic client whose model is down: every call fails. */
class DownModel extends DemoBrain implements ChatModel {
  readonly agentModel = 'down';
  calls = 0;
  plans = 0;
  async streamChat(_request: ChatModelRequest): Promise<ChatModelResponse> { this.calls++; throw new Error('overloaded_error'); }
  override async plan(...args: Parameters<DemoBrain['plan']>) { this.plans++; return super.plan(...args); }
}

test('when the model is down she says so in one line, and does not ask the planner (the same model) instead', async () => {
  const model = new DownModel();
  const health = new ProviderHealth();
  const deps = guardProviders({ tenant: { id: 't', name: 'T' } as never, connections: { boards: ['demo'], repositories: ['demo'], authorizedActorIds: ['roee'] },
    board: new DemoBoard(), code: new DemoCode(), brain: model, agent: model, identities: undefined as never, people: undefined as never,
    policy: new AllowlistPolicy(new Set(['roee'])) }, health);
  assert.strictEqual(deps.agent, deps.brain, 'one proxy, one breaker for the brain and the agent');
  for (let i = 0; i < 3; i++) await deps.agent!.streamChat({} as ChatModelRequest, () => undefined).catch(() => undefined);
  assert.equal(health.snapshot().anthropic, 'open');

  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: deps.board, code: deps.code, brain: deps.brain, agent: deps.agent, policy: deps.policy },
    { schedule: () => 0, cancel: () => undefined });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, what is on the board?', eventId: '1', actor: { id: 'roee', displayName: 'Roee', verified: true } });
  const said = meeting.events.filter(event => event.type === 'speak' || event.type === 'chat').map(event => event.text);
  assert.deepEqual(said, ['Sorry, my thinking service is down right now, so I can’t answer that. Try me again in a minute.']);
  assert.equal(model.calls, 3, 'the model was not called again');
  assert.equal(model.plans, 0);
});

test('NOGITA_PROVIDER_BREAKER is off unless set to true', () => {
  assert.equal(providerBreakers({}), false);
  assert.equal(providerBreakers({ NOGITA_PROVIDER_BREAKER: 'true' }), true);
  assert.throws(() => providerBreakers({ NOGITA_PROVIDER_BREAKER: 'yes' }), /must be true or false/);
});
