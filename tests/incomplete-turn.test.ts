import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import type { Utterance } from '../src/core/contracts.ts';

test('opt-in incomplete hold merges a paused request, preserves all input IDs and skips premature speculation', async () => {
  const emitted: Utterance[] = [];
  const early: Utterance[] = [];
  const jobs = new Map<unknown, { work: () => void | Promise<void>; ms: number }>();
  const router = new AttendeeCommandRouter(async (_s, utterance) => { emitted.push(utterance); }, async () => {}, {
    chatAck: false, incompleteTurnHoldMs: 2500,
    schedule: (work, ms) => { const key = {}; jobs.set(key, { work, ms }); return key; }, cancel: key => { jobs.delete(key); },
    speculate: (_s, u) => { early.push(u); return { cancel() {} }; },
  });
  router.beginSession('s');
  const request = (text: string, id: string) => ({ sessionId: 's', botId: 'bot_test', speakerUuid: 'p',
    utterance: { eventId: id, inputTurnIds: [id], text, actor: { id: 'a', displayName: 'A', verified: true } } });
  router.acceptEagerTurn(request('Nogita, can you check?', 'one'));
  const first = router.acceptCompletedTurn(request('Nogita, can you check?', 'one'));
  assert.equal(emitted.length, 0); assert.equal(early.length, 0);
  assert.equal([...jobs.values()][0]!.ms, 2500);
  router.noteSpeechActivity('s', 'p');
  assert.equal([...jobs.values()][0]!.ms, 2500);
  router.acceptEagerTurn(request('which file starts the server?', 'two'));
  assert.deepEqual(early[0]!.inputTurnIds, ['one', 'two']);
  await router.acceptCompletedTurn(request('which file starts the server?', 'two'));
  await first;
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.text, 'Nogita, can you check? which file starts the server?');
  assert.deepEqual(emitted[0]!.inputTurnIds, ['one', 'two']);
  router.endSession('s');
});

test('incomplete hold times out, while complete questions and default behavior are immediate', async () => {
  for (const [hold, text, expectedDelay] of [
    [2500, 'Nogita, can you check?', true], [2500, 'Nogita, can you check the deploy?', false],
    [0, 'Nogita, can you check?', false], [2500, 'Nogita, how many open tasks?', false],
    [2500, 'Nogita, how many open?', false],
    // Live Meet 2026-10-31: a follow-up broken off mid-search ("All the the?") was answered three times.
    [2500, 'All the the?', true], [2500, 'I want to open tasks for the', true], [2500, 'Open tasks for all of them.', false],
  ] as const) {
    const emitted: string[] = [];
    const jobs = new Map<unknown, () => void | Promise<void>>();
    const router = new AttendeeCommandRouter(async (_s, u) => { emitted.push(u.text); }, async () => {}, {
      chatAck: false, incompleteTurnHoldMs: hold,
      schedule: work => { const key = {}; jobs.set(key, work); return key; }, cancel: key => { jobs.delete(key); },
    });
    router.beginSession('s');
    const pending = router.acceptCompletedTurn({ sessionId: 's', botId: 'bot_test', speakerUuid: 'p',
      utterance: { eventId: 'one', text, actor: { id: 'a', displayName: 'A', verified: true } } });
    assert.equal(emitted.length, expectedDelay ? 0 : 1, text);
    for (const work of jobs.values()) await work();
    await pending;
    assert.deepEqual(emitted, [text]);
    router.endSession('s');
  }
});

test('invalid incomplete turn configuration is rejected', () => {
  for (const incompleteTurnHoldMs of [-1, 5001, NaN, Infinity]) {
    assert.throws(() => new AttendeeCommandRouter(async () => {}, async () => {}, { incompleteTurnHoldMs }), /incompleteTurnHoldMs/);
  }
});

// P5-14: the half-sentences she answered in the Meets of 1 and 3 November.
async function heldThenAnswered(text: string, wide: boolean, go?: string) {
  const emitted: string[] = [];
  const jobs = new Map<unknown, () => void | Promise<void>>();
  const router = new AttendeeCommandRouter(async (_s, u) => { emitted.push(u.text); }, async () => {}, {
    chatAck: false, incompleteTurnHoldMs: 1500, wideIncompleteTurns: wide,
    schedule: work => { const key = {}; jobs.set(key, work); return key; }, cancel: key => { jobs.delete(key); },
  });
  router.beginSession('s');
  const request = (words: string, id: string) => ({ sessionId: 's', botId: 'bot_test', speakerUuid: 'p',
    utterance: { eventId: id, text: words, actor: { id: 'a', displayName: 'A', verified: true } } });
  const pending = [router.acceptCompletedTurn(request(text, 'one'))];
  const heldAtFirst = emitted.length === 0;
  if (go) pending.push(router.acceptCompletedTurn(request(go, 'two')));
  for (const work of [...jobs.values()]) await work();
  await Promise.all(pending);
  router.endSession('s');
  return { heldAtFirst, emitted };
}

test('NOGITA_WIDE_INCOMPLETE_TURNS holds the Meet fragments; complete short requests go at once', async () => {
  for (const fragment of ["So, I'm wondering?", 'You need to combine.', 'All the PR that we pushed today.', 'In jira.',
    'Um, okay, so please.', 'Nogita, I want to', "Nogita, I'm wondering"]) {
    assert.equal((await heldThenAnswered(fragment, true)).heldAtFirst, true, fragment);
  }
  for (const complete of ['Nogita, what landed today?', 'Nogita, how are you?', 'Nogita, open a task for the cache headers.',
    'Nogita, are you connected to jira?', 'Nogita, summarize.', 'Nogita, approve 1 and 3.'])
    assert.equal((await heldThenAnswered(complete, true)).heldAtFirst, false, complete);
});

test('the words after the pause join the fragment; a fragment nobody finishes is still answered when the hold ends', async () => {
  const joined = await heldThenAnswered("So, I'm wondering?", true, 'What was pushed to main today?');
  assert.deepEqual(joined.emitted, ["So, I'm wondering? What was pushed to main today?"]);
  assert.deepEqual((await heldThenAnswered('You need to combine.', true)).emitted, ['You need to combine.']);
  assert.equal((await heldThenAnswered('You need to combine.', false)).heldAtFirst, false, 'off: as in the Meet');
});
