import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import type { AttendeeTranscriptRequest } from '../src/app/attendee-webhook.ts';
import type { Actor, Utterance } from '../src/core/contracts.ts';

const owner: Actor = { id: 'roee', displayName: 'Roee Angel', verified: true };
const jobs: Array<() => void | Promise<void>> = [];
function fixture() {
  jobs.length = 0;
  const emitted: Array<{ sessionId: string; utterance: Utterance }> = [];
  const statuses: string[] = [];
  const leaves: string[] = [];
  const router = new AttendeeCommandRouter(
    async (sessionId, utterance) => { emitted.push({ sessionId, utterance }); },
    async (_sessionId, message) => { statuses.push(message); },
    { randomCode: () => '482731', onLeave: async sessionId => { leaves.push(sessionId); },
      schedule: work => { jobs.push(work); return work; }, cancel: handle => {
      const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1);
    } },
  );
  const request = (speakerUuid: string, text: string, eventId: string, actor: Actor = {
    id: `unmapped:attendee:${speakerUuid}`, displayName: 'Guest', verified: false,
  }): AttendeeTranscriptRequest => ({ sessionId: 's', botId: 'bot_1', speakerUuid,
    utterance: { eventId, actor, text } });
  const flush = async () => { while (jobs.length) await jobs.shift()!(); };
  return { router, emitted, statuses, leaves, request, flush };
}

test('assembles adjacent fragments from one speaker into one utterance', async () => {
  const f = fixture(); f.router.beginSession('s');
  f.router.accept(f.request('speaker-a', 'Hey Nogita, open a task that you will', 'a1', owner));
  f.router.accept(f.request('speaker-a', 'learn how to speak.', 'a2', owner));
  await f.flush();
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]?.utterance.text, 'Hey Nogita, open a task that you will learn how to speak.');
});

test('never combines fragments from different speakers', async () => {
  const f = fixture(); f.router.beginSession('s');
  f.router.accept(f.request('speaker-a', 'Nogita, first', 'a1', owner));
  f.router.accept(f.request('speaker-b', 'Nogita, second', 'b1', owner));
  await f.flush();
  assert.deepEqual(f.emitted.map(x => x.utterance.text).sort(), ['Nogita, first', 'Nogita, second']);
});

test('wrong challenge cannot authorize and direct request receives chat guidance', async () => {
  const f = fixture(); const phrase = f.router.beginSession('s', owner);
  assert.equal(phrase, 'Nogita verify 482731');
  f.router.accept(f.request('speaker-a', 'Nogita verify 111111', 'a1'));
  await f.flush();
  assert.equal(f.emitted.length, 0);
  assert.match(f.statuses.at(-1) ?? '', /cannot verify/i);
});

test('correct challenge binds only that meeting speaker and replay is ignored', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita verify 482731', 'verify-1'));
  await f.flush();
  assert.match(f.statuses.at(-1) ?? '', /verified/i);
  f.router.accept(f.request('speaker-a', 'Nogita, what time is it?', 'question-1'));
  f.router.accept(f.request('speaker-a', 'Nogita, what time is it?', 'question-1'));
  await f.flush();
  assert.equal(f.emitted.length, 1);
  assert.deepEqual(f.emitted[0]?.utterance.actor, owner);
});

test('ending a session clears pending fragments, challenge, and binding', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita verify 482731', 'verify-1'));
  await f.flush();
  f.router.accept(f.request('speaker-a', 'Nogita, create a task', 'task-1'));
  f.router.endSession('s');
  await f.flush();
  assert.equal(f.emitted.length, 0);
  assert.equal(f.router.sessionCount(), 0);
});

test('accept resolves only after combined command processing completes', async () => {
  const f = fixture(); f.router.beginSession('s');
  let settled = false;
  const accepted = f.router.accept(f.request('speaker-a', 'Nogita, hello', 'a1', owner))
    .then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  await f.flush();
  await accepted;
  assert.equal(settled, true);
});

test('same-speaker fragments are ordered by provider timestamp', async () => {
  const f = fixture(); f.router.beginSession('s');
  const later = f.request('speaker-a', 'second', 'a2', owner); later.utterance.at = 2;
  const earlier = f.request('speaker-a', 'Nogita, first', 'a1', owner); earlier.utterance.at = 1;
  f.router.accept(later); f.router.accept(earlier);
  await f.flush();
  assert.equal(f.emitted[0]?.utterance.text, 'Nogita, first second');
});

test('verified owner leave request exits the meeting without asking the model', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita verify 482731', 'verify-1'));
  await f.flush();
  f.router.accept(f.request('speaker-a', 'Nogita, you can leave', 'leave-1'));
  await f.flush();
  assert.deepEqual(f.leaves, ['s']);
  assert.equal(f.emitted.length, 0);
});

test('failed command processing is released for a bounded provider retry', async () => {
  jobs.length = 0;
  let attempts = 0;
  const statuses: string[] = [];
  const router = new AttendeeCommandRouter(async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary planner failure');
  }, async (_sessionId, message) => { statuses.push(message); }, {
    schedule: work => { jobs.push(work); return work; },
    cancel: handle => { const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1); },
  });
  router.beginSession('s');
  const request = {
    sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'retry-me', actor: owner, text: 'Nogita, create a task' },
  };
  const first = router.accept(request);
  await jobs.shift()!();
  await assert.rejects(first, /temporary planner failure/);
  assert.match(statuses.at(-1) ?? '', /try again/i);

  const second = router.accept(request);
  await jobs.shift()!();
  await second;
  assert.equal(attempts, 2);
});

test('failed verification acknowledgement does not bind the speaker prematurely', async () => {
  jobs.length = 0;
  let statuses = 0;
  const emitted: Utterance[] = [];
  const router = new AttendeeCommandRouter(async (_sessionId, utterance) => { emitted.push(utterance); }, async () => {
    statuses++;
    if (statuses === 1) throw new Error('temporary chat failure');
  }, {
    randomCode: () => '482731',
    schedule: work => { jobs.push(work); return work; },
    cancel: handle => { const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1); },
  });
  router.beginSession('s', owner);
  const challenge = { sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'verify', actor: { id: 'guest', displayName: 'Guest', verified: false }, text: 'Nogita verify 482731' } };
  const first = router.accept(challenge);
  await jobs.shift()!();
  await assert.rejects(first, /temporary chat failure/);
  const retry = router.accept(challenge);
  await jobs.shift()!();
  await retry;
  assert.equal(emitted.length, 0);
  assert.equal(statuses, 3); // failure, fallback, then successful verification
});
