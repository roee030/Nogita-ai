import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy, directlyAddressesNogita, isExplicitCreateRequest } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { BrainPort, Plan } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const engineer = { id: 'engineer', displayName: 'Engineer', verified: true };
function fixture(brain: BrainPort = new DemoBrain()) {
  const meeting = new DemoMeeting('m');
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain, policy: new AllowlistPolicy(new Set(['lead'])) });
  const utter = (text: string, eventId: string, actor = lead) => engine.onUtterance('s', { text, eventId, actor });
  return { engine, meeting, board, utter };
}

test('activation: direct name address only', () => {
  for (const text of ['Nogita, hello', 'Hey Nogita, check', 'Nogita what do you think?']) assert.equal(directlyAddressesNogita(text), true);
  for (const text of ['We talked about Nogita', 'Rename Nogita today', 'NogitaBot', 'That is a great idea']) assert.equal(directlyAddressesNogita(text), false);
});
test('no speech without name; relevant concern only raises hand', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('The release is tomorrow.', '1'), 'ignored');
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 0);
  assert.equal(await f.utter('This seems like a critical security risk.', '2'), 'raised_hand');
  assert.equal(f.meeting.events.filter(e => e.type === 'raise_hand').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('only explicitly addressed response may produce speech', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, hello there', '1'), 'answered');
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('create task -> short spoken acknowledgement and completed chat receipt', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a task to check authentication refresh tokens', '1'), 'completed');
  assert.equal(f.board.tasks.length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  const receipt = f.meeting.events.find(e => e.type === 'chat');
  assert.match(receipt?.text ?? '', /DEMO-1/);
});
test('guard prohibits model-initiated writes despite plan', async () => {
  const malicious: BrainPort = { plan: async (): Promise<Plan> => ({ kind: 'create_task', title: 'wrong', description: 'wrong' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false };
  const f = fixture(malicious); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, what is our timeline?', '1'), 'denied');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('unverified and unauthorized actor can never create task', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a task for security review', '1', engineer), 'denied');
  assert.equal(await f.utter('Nogita, create a task for security review', '2', { ...lead, verified: false }), 'ignored');
  assert.equal(f.board.tasks.length, 0);
});
test('replayed event does not duplicate external task', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, create a task for tests', '1');
  assert.equal(await f.utter('Nogita, create a task for tests', '1'), 'ignored');
  assert.equal(f.board.tasks.length, 1);
});
test('code evidence returns spoken grounded answer plus reference receipt', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how is auth implemented in the repo?', '1'), 'completed');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 1);
});
test('draft PR has an explicit not-supported response; never modifies repo', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a draft PR for that bug', '1'), 'not_supported');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('meeting state purged on end, cannot accept more utterances', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, hello', '1');
  await f.engine.endSession('s');
  assert.equal(f.engine.sessionCount(), 0);
  await assert.rejects(() => f.utter('Nogita, hello', '2'), /unknown session/);
});

test('provider-ended meeting purges state without sending a redundant leave command', async () => {
  const f = fixture();
  await f.engine.startSession('provider-ended', f.meeting);
  await f.engine.endSession('provider-ended', false);
  assert.equal(f.engine.sessionCount(), 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'leave').length, 0);
});

test('failed event processing can be retried instead of being silently discarded', async () => {
  const f = fixture();
  await f.engine.startSession('retryable', f.meeting);
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  let attempts = 0;
  f.meeting.speak = async text => {
    attempts++;
    if (attempts === 1) throw new Error('temporary speech failure');
    return originalSpeak(text);
  };
  await assert.rejects(() => f.engine.onUtterance('retryable', {
    eventId: 'retry-event', actor: { id: 'lead', displayName: 'Lead', verified: true }, text: 'Nogita, hello',
  }), /temporary speech failure/);
  assert.equal(await f.engine.onUtterance('retryable', {
    eventId: 'retry-event', actor: { id: 'lead', displayName: 'Lead', verified: true }, text: 'Nogita, hello',
  }), 'answered');
});

test('utterances in one session are serialized so a failed rollback cannot erase a concurrent event', async () => {
  const histories: string[][] = [];
  const brain: BrainPort = {
    plan: async (_current, history): Promise<Plan> => {
      histories.push([...history]);
      return { kind: 'answer', message: 'ok' };
    },
    answerWithEvidence: async () => '',
    suggestContribution: async () => false,
  };
  const f = fixture(brain);
  await f.engine.startSession('serialized', f.meeting);
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  let attempts = 0;
  f.meeting.speak = async text => {
    attempts++;
    if (attempts === 1) {
      markStarted();
      await firstGate;
      throw new Error('first event failed');
    }
    return originalSpeak(text);
  };
  const first = f.engine.onUtterance('serialized', {
    eventId: 'first', actor: lead, text: 'Nogita, first',
  });
  await firstStarted;
  const second = f.engine.onUtterance('serialized', {
    eventId: 'second', actor: lead, text: 'Nogita, second',
  });
  await Promise.resolve();
  assert.equal(attempts, 1);
  releaseFirst();
  await assert.rejects(first, /first event failed/);
  assert.equal(await second, 'answered');
  assert.deepEqual(histories, [[], []]);
});

test('ending a session drains in-flight speech and refuses new utterances', async () => {
  const f = fixture();
  await f.engine.startSession('ending', f.meeting);
  let releaseSpeak!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseSpeak = resolve; });
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  f.meeting.speak = async text => {
    markStarted();
    await gate;
    await originalSpeak(text);
  };
  const active = f.engine.onUtterance('ending', { eventId: 'active', actor: lead, text: 'Nogita, hello' });
  await started;
  const ending = f.engine.endSession('ending');
  await assert.rejects(() => f.engine.onUtterance('ending', {
    eventId: 'late', actor: lead, text: 'Nogita, too late',
  }), /unknown session/);
  assert.equal(f.meeting.events.some(event => event.type === 'leave'), false);
  releaseSpeak();
  assert.equal(await active, 'answered');
  await ending;
  assert.equal(f.meeting.events.at(-1)?.type, 'leave');
});
test('create task request is recognized, question not treated as request', () => {
  assert.equal(isExplicitCreateRequest('create a jira task'), true);
  assert.equal(isExplicitCreateRequest('Do we have a task about auth?'), false);
});
