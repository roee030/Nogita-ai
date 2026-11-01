import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMITS, RateLimiter, rateLimitConfig } from '../src/app/rate-limits.ts';
import { SessionUsageRegistry } from '../src/app/session-usage.ts';
import { buildToolbox, type WriteAudit } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

const limits = (overrides: Partial<typeof DEFAULT_RATE_LIMITS>) => ({ ...DEFAULT_RATE_LIMITS, ...overrides });
const roee = { actorId: 'roee', sessionId: 'meeting-1' };

test('a person reaches the hourly cap: the next write is refused with when it frees up, and the hour slides', () => {
  let now = 0;
  const limiter = new RateLimiter(limits({ writesPerPersonHour: 3 }), () => now);
  for (let i = 0; i < 3; i++) { assert.equal(limiter.take('write', roee), undefined); now += 10 * 60_000; }
  assert.equal(limiter.take('write', roee), 'You\'ve reached the limit of 3 changes an hour, so I didn\'t do that. It frees up in 30 minutes.');
  // Someone else, and model calls, are counted apart.
  assert.equal(limiter.take('write', { actorId: 'dana', sessionId: 'meeting-1' }), undefined);
  assert.equal(limiter.take('model_call', roee), undefined);
  now = 60 * 60_000;
  assert.equal(limiter.take('write', roee), undefined, 'the first write is an hour old');
});

test('a meeting reaches its cap across people; a mission counts only against its owner', () => {
  const limiter = new RateLimiter(limits({ writesPerMeeting: 2, modelCallsPerMeeting: 1 }));
  assert.equal(limiter.take('write', { actorId: 'roee', sessionId: 'm' }), undefined);
  assert.equal(limiter.take('write', { actorId: 'dana', sessionId: 'm' }), undefined);
  assert.match(limiter.take('write', { actorId: 'avi', sessionId: 'm' })!, /the 2 changes I'm allowed in one meeting/);
  assert.equal(limiter.take('write', { actorId: 'roee', sessionId: 'mission-M-1' }), undefined);
  assert.equal(limiter.take('model_call', { actorId: 'roee', sessionId: 'm' }), undefined);
  assert.match(limiter.take('model_call', { actorId: 'dana', sessionId: 'm' })!, /my limit for this meeting/);
  limiter.endMeeting('m');
  assert.equal(limiter.take('write', { actorId: 'avi', sessionId: 'm' }), undefined, 'an ended meeting frees its counter');
});

test('counters: how often each cap refused, and who is close to one', () => {
  const limiter = new RateLimiter(limits({ writesPerPersonHour: 5, writesPerMeeting: 100 }));
  for (let i = 0; i < 6; i++) limiter.take('write', roee);
  const counters = limiter.counters();
  assert.deepEqual(counters.refused, { writesPerPerson: 1, writesPerMeeting: 0, modelCallsPerPerson: 0, modelCallsPerMeeting: 0 });
  assert.deepEqual(counters.near, [{ kind: 'write', scope: 'person', id: 'roee', used: 5, limit: 5 }]);
});

test('NOGITA_RATE_LIMITS is off unless true; the caps come from the environment', () => {
  assert.equal(rateLimitConfig({}), undefined);
  assert.deepEqual(rateLimitConfig({ NOGITA_RATE_LIMITS: 'true' }), DEFAULT_RATE_LIMITS);
  assert.equal(rateLimitConfig({ NOGITA_RATE_LIMITS: 'true', NOGITA_RATE_WRITES_PER_MEETING: '12' })!.writesPerMeeting, 12);
  assert.throws(() => rateLimitConfig({ NOGITA_RATE_LIMITS: 'true', NOGITA_RATE_WRITES_PER_MEETING: '0' }), /at least 1/);
  assert.throws(() => rateLimitConfig({ NOGITA_RATE_LIMITS: 'on' }), /true or false/);
});

test('a write past the cap never reaches the board or the audit log, and the tool result says why', async () => {
  const board = new MemoryBoard('Jira', 'KAN');
  const audited: WriteAudit[] = [];
  const { toolbox } = buildToolbox({ actor: { id: 'roee', displayName: 'Roee', verified: true }, request: 'Nogita, create two tasks: one for retries and one for docs',
    sessionId: 'meeting-1', eventId: 'e', policy: new AllowlistPolicy(new Set(['roee'])), code: new DemoCode(), board, completed: new Map(),
    onReceipt: async () => undefined, audit: write => audited.push(write), limits: new RateLimiter(limits({ writesPerPersonHour: 1 })) });
  await toolbox.run('create_task', { title: 'Retries', description: 'Add retries.' });
  const second = await toolbox.run('create_task', { title: 'Docs', description: 'Write docs.' })
    .catch((error: Error) => ({ content: `Tool failed: ${error.message}`, isError: true }));
  assert.equal(board.tasks.length, 1);
  assert.equal(audited.length, 1);
  assert.match(second.content, /limit of 1 changes an hour.*Nothing was done/);
});

class OneLineModel extends DemoBrain implements ChatModel {
  readonly agentModel = 'one-line';
  calls = 0;
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.calls++;
    onText('Two tasks are open.');
    return { content: [{ type: 'text', text: 'Two tasks are open.' }], stopReason: 'end_turn' };
  }
}

test('past the meeting\'s cap on model calls she says so in one line and the model is not called', async () => {
  const model = new OneLineModel();
  const usage = new SessionUsageRegistry();
  const limiter = new RateLimiter(limits({ modelCallsPerMeeting: 1 }), Date.now, (kind, _scope, who) => usage.recordRateLimited(who.sessionId, kind));
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new MemoryBoard(), code: new DemoCode(), brain: model, agent: model,
    policy: new AllowlistPolicy(new Set(['roee'])), limits: limiter }, { schedule: () => 0, cancel: () => undefined });
  usage.start('s', 'demo');
  await engine.startSession('s', meeting);
  const actor = { id: 'roee', displayName: 'Roee', verified: true };
  await engine.onUtterance('s', { text: 'Nogita, what is open?', eventId: '1', actor });
  await engine.onUtterance('s', { text: 'Nogita, and what is done?', eventId: '2', actor });
  const said = meeting.events.filter(event => event.type === 'speak').map(event => event.text);
  assert.equal(model.calls, 1);
  assert.equal(said.at(-1), 'I\'ve reached my limit for this meeting, so I\'ll stop answering here. You can ask me in Slack.');
  assert.deepEqual(usage.report('s')?.rateLimited, { writes: 0, modelCalls: 1 });
});
