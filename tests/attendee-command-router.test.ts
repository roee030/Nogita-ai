import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import type { AttendeeTranscriptRequest } from '../src/app/attendee-webhook.ts';
import type { Actor, Utterance } from '../src/core/contracts.ts';
import { InvalidPlanningResponseError } from '../src/core/contracts.ts';

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

test('spoken verification digits bind only the speaker who said the challenge', async () => {
  for (const [index, spoken] of [
    'Nogita verify four, eight, two, seven, three, one.',
    'Ah, nogita. Verify four, eight, two, seven, three, one.',
    'Nogita verify 48-2731.',
    'Nogita verify four 8 two 7 three 1.',
    'Nogeta verify 482731.',
    'Novita verify four, eight, two, seven, three, one.',
    'No nogita verify 482731.',
  ].entries()) {
    const f = fixture(); f.router.beginSession('s', owner);
    f.router.accept(f.request('speaker-a', spoken, `verify-${index}`));
    await f.flush();
    assert.match(f.statuses.at(-1) ?? '', /verified/i, spoken);
    f.router.accept(f.request('speaker-a', 'Nogita, explain the repository', `owner-${index}`));
    f.router.accept(f.request('speaker-b', 'Nogita, open a task', `other-${index}`));
    await f.flush();
    assert.equal(f.emitted.length, 1, spoken);
    assert.deepEqual(f.emitted[0]?.utterance.actor, owner);
  }
});

test('spoken verification rejects wrong, extra, and action-bearing codes', async () => {
  for (const [index, spoken] of [
    'Nogita verify four eight two seven three zero',
    'Nogita verify four eight two seven three one five',
    'Nogita verify 482731 and open a task',
    'Nogita verify 48273',
  ].entries()) {
    const f = fixture(); f.router.beginSession('s', owner);
    f.router.accept(f.request('speaker-a', spoken, `wrong-${index}`));
    await f.flush();
    assert.doesNotMatch(f.statuses.at(-1) ?? '', /^Verified /i, spoken);
    f.router.accept(f.request('speaker-a', 'Nogita, explain the repository', `question-${index}`));
    await f.flush();
    assert.equal(f.emitted.length, 0, spoken);
  }
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

test('a provider-final utterance waits for the quiet window and keeps verification policy', async () => {
  jobs.length = 0;
  const f = fixture(); f.router.beginSession('s', owner);
  const accepted = f.router.acceptFinal(f.request('speaker-a', 'Nogita verify 482731', 'final-1'));
  assert.equal(jobs.length, 1);
  assert.equal(f.statuses.length, 0);
  await f.flush();
  await accepted;
  assert.match(f.statuses.at(-1) ?? '', /verified/i);
  assert.equal(f.emitted.length, 0);
});
test('a semantic completed turn is processed without another quiet-window delay', async () => {
  const f = fixture(); f.router.beginSession('s');
  const request = f.request('speaker-a', 'Nogita, what time is it?', 'flux-turn', owner);
  const accepted = f.router.acceptCompletedTurn(request);
  await accepted;
  assert.equal(f.emitted.length, 1);
  assert.equal(jobs.length, 0);
});
test('router records transcript-to-chat acknowledgement without retaining speech', async () => {
  const samples: Array<{ sessionId: string; durationMs: number }> = [];
  const router = new AttendeeCommandRouter(async () => {}, async () => {}, {
    onChatAck: (sessionId, durationMs) => samples.push({ sessionId, durationMs }),
  });
  router.beginSession('s', owner);
  await router.acceptCompletedTurn({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'measured', actor: owner, text: 'Nogita, hello' } });
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.sessionId, 's');
  assert.ok(Number.isFinite(samples[0]?.durationMs));
  assert.ok(samples[0]!.durationMs >= 0);
});
test('interim speech activity reaches the engine even after the transcript buffer was flushed', () => {
  const activity: string[] = [];
  const router = new AttendeeCommandRouter(async () => {}, async () => {}, {
    onSpeechActivity: sessionId => { activity.push(sessionId); },
  });
  router.beginSession('s', owner);
  router.noteSpeechActivity('s', 'speaker-a');
  assert.deepEqual(activity, ['s']);
});
test('resumed interim speech resets the quiet timer without adding transcript text', async () => {
  const f = fixture(); f.router.beginSession('s');
  const accepted = f.router.acceptFinal(f.request('speaker-a', 'Nogita, tell me about the', 'final-a', owner));
  assert.equal(jobs.length, 1);
  f.router.noteSpeechActivity('s', 'speaker-a');
  assert.equal(jobs.length, 1);
  await f.flush();
  await accepted;
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]?.utterance.text, 'Nogita, tell me about the');
});
test('provider-final fragments from the same speaker reset the timer and become one utterance', async () => {
  jobs.length = 0;
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita verify 482731', 'verify-1'));
  await f.flush();
  const first = f.router.acceptFinal(f.request('speaker-a', 'Nogita, can you explain how the', 'final-a'));
  assert.equal(jobs.length, 1);
  const second = f.router.acceptFinal(f.request('speaker-a', 'repository search works?', 'final-b'));
  assert.equal(jobs.length, 1);
  await f.flush();
  await Promise.all([first, second]);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]?.utterance.text, 'Nogita, can you explain how the repository search works?');
});
test('provider-final speech from different speakers stays in separate quiet-window buffers', async () => {
  jobs.length = 0;
  const f = fixture(); f.router.beginSession('s', owner);
  const first = f.router.acceptFinal(f.request('speaker-a', 'Nogita, answer from speaker A', 'final-a', owner));
  const second = f.router.acceptFinal(f.request('speaker-b', 'Nogita, answer from speaker B', 'final-b', owner));
  assert.equal(jobs.length, 2);
  await f.flush();
  await Promise.all([first, second]);
  assert.deepEqual(f.emitted.map(result => result.utterance.text).sort(), [
    'Nogita, answer from speaker A', 'Nogita, answer from speaker B',
  ]);
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
test('transcript-derived drop meeting command leaves without reaching the model', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita drop this meeting.', 'drop-meeting', owner));
  await f.flush();
  assert.deepEqual(f.leaves, ['s']);
  assert.equal(f.emitted.length, 0);
});
test('explicit end this meeting command still leaves without reaching the model', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita, end this meeting.', 'end-meeting', owner));
  await f.flush();
  assert.deepEqual(f.leaves, ['s']);
  assert.equal(f.emitted.length, 0);
});
test('sentence-later direct request reaches the engine after fragment assembly', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Let’s do them both.', 'preface', owner));
  f.router.accept(f.request('speaker-a', 'Nogita, what is the project about?', 'request', owner));
  await f.flush();
  assert.equal(f.emitted.length, 1);
  assert.match(f.statuses.at(-1) ?? '', /checking/i);
});
test('negated or calendar drop is never interpreted as a meeting leave command', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', "Nogita, don't drop this meeting yet.", 'dont-drop', owner));
  await f.flush();
  f.router.accept(f.request('speaker-a', 'Nogita, should we drop this meeting from the calendar?', 'calendar-drop', owner));
  await f.flush();
  assert.deepEqual(f.leaves, []);
  assert.equal(f.emitted.length, 2);
});
test('a question about leaving is not a command, but an explicit can-you request is', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', 'Nogita, leave this meeting?', 'leave-question', owner));
  await f.flush();
  assert.deepEqual(f.leaves, []);
  f.router.accept(f.request('speaker-a', 'Nogita, can you leave this meeting?', 'can-you-leave', owner));
  await f.flush();
  assert.deepEqual(f.leaves, ['s']);
});
test('a prior clause about dropping a meeting does not turn the later addressed request into leave', async () => {
  const f = fixture(); f.router.beginSession('s', owner);
  f.router.accept(f.request('speaker-a', "I'll drop this meeting. Nogita, explain the plan.", 'clause-drop', owner));
  await f.flush();
  assert.deepEqual(f.leaves, []);
  assert.equal(f.emitted.length, 1);
});
test('verified direct request gets a chat acknowledgement before slow processing starts', async () => {
  jobs.length = 0;
  const order: string[] = [];
  const router = new AttendeeCommandRouter(async () => { order.push('process'); },
    async (_sessionId, message) => { order.push(`chat:${message}`); }, { quietMs: 0,
      schedule: work => { jobs.push(work); return work; }, cancel: () => {} });
  router.beginSession('s', owner);
  const accepted = router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-1',
    utterance: { eventId: 'ack-1', actor: owner, text: 'Nogita, what did we push to main?' } });
  await jobs.shift()!();
  await accepted;
  assert.deepEqual(order, ['chat:I heard you. I’m checking that now.', 'process']);
});
test('acknowledgement failure does not suppress a verified request', async () => {
  jobs.length = 0;
  let processed = false;
  const errors: unknown[] = [];
  const router = new AttendeeCommandRouter(async () => { processed = true; },
    async () => { throw new Error('chat unavailable'); }, { quietMs: 0, onError: error => errors.push(error),
      schedule: work => { jobs.push(work); return work; }, cancel: () => {} });
  router.beginSession('s', owner);
  const accepted = router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-1',
    utterance: { eventId: 'ack-2', actor: owner, text: 'Nogita, what is in the repo?' } });
  await jobs.shift()!();
  await accepted;
  assert.equal(processed, true);
  assert.equal(errors.length, 1);
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

test('invalid planner output ends one request with one acknowledgement and one failure notice', async () => {
  jobs.length = 0;
  let attempts = 0;
  const statuses: string[] = [];
  const router = new AttendeeCommandRouter(async () => {
    attempts++;
    throw new InvalidPlanningResponseError('invalid planning JSON');
  }, async (_sessionId, message) => { statuses.push(message); }, {
    schedule: work => { jobs.push(work); return work; },
    cancel: handle => { const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1); },
  });
  router.beginSession('s', owner);
  const request = { sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'invalid-plan', actor: owner, text: 'Nogita, what is the repository about?' } };
  const first = router.accept(request);
  await jobs.shift()!();
  await first;
  await router.accept(request);
  assert.equal(attempts, 1);
  assert.equal(statuses.filter(status => /checking/i.test(status)).length, 1);
  assert.equal(statuses.filter(status => /could not complete/i.test(status)).length, 1);
});

test('a provider retry does not repeat acknowledgement or failure notice for the same utterance', async () => {
  jobs.length = 0;
  let attempts = 0;
  const statuses: string[] = [];
  const router = new AttendeeCommandRouter(async () => {
    attempts++;
    if (attempts < 3) throw new Error('transient failure');
  }, async (_sessionId, message) => { statuses.push(message); }, {
    schedule: work => { jobs.push(work); return work; },
    cancel: handle => { const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1); },
  });
  router.beginSession('s', owner);
  const request = { sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'retry-once-notice', actor: owner, text: 'Nogita, check the repository' } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const accepted = router.accept(request);
    await jobs.shift()!();
    if (attempt < 2) await assert.rejects(accepted, /transient failure/);
    else await accepted;
  }
  assert.equal(attempts, 3);
  assert.equal(statuses.filter(status => /checking/i.test(status)).length, 1);
  assert.equal(statuses.filter(status => /could not complete/i.test(status)).length, 1);
});

test('a provider retry of one fragment does not repeat notices for the original combined utterance', async () => {
  jobs.length = 0;
  const statuses: string[] = [];
  const router = new AttendeeCommandRouter(async () => { throw new Error('transient failure'); },
    async (_sessionId, message) => { statuses.push(message); }, {
      schedule: work => { jobs.push(work); return work; },
      cancel: handle => { const index = jobs.indexOf(handle as () => void | Promise<void>); if (index >= 0) jobs.splice(index, 1); },
    });
  router.beginSession('s', owner);
  const first = router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'fragment-a', actor: owner, text: 'Nogita, what is the' } });
  const second = router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'fragment-b', actor: owner, text: 'repository about?' } });
  await jobs.shift()!();
  await assert.rejects(Promise.all([first, second]), /transient failure/);
  const retry = router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid: 'speaker-a',
    utterance: { eventId: 'fragment-b', actor: owner, text: 'repository about?' } });
  await jobs.shift()!();
  await assert.rejects(retry, /transient failure/);
  assert.equal(statuses.filter(status => /checking/i.test(status)).length, 1);
  assert.equal(statuses.filter(status => /could not complete/i.test(status)).length, 1);
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

test('early end-of-turn: the confirmed turn carries the early start when the words match, otherwise it is rolled back', async () => {
  const contexts: Array<{ text: string; speculation?: unknown }> = [];
  const started: string[] = [];
  const cancelled: string[] = [];
  const router = new AttendeeCommandRouter(
    async (_sessionId, utterance, context) => { contexts.push({ text: utterance.text, speculation: context.speculation }); },
    async () => undefined,
    { speculate: (_sessionId, utterance) => {
      started.push(utterance.text);
      return { cancel: () => { cancelled.push(utterance.text); } };
    } });
  router.beginSession('s');
  const request = (text: string, eventId: string) => ({ sessionId: 's', botId: 'bot_1', speakerUuid: 'a', utterance: { eventId, actor: owner, text } });
  router.acceptEagerTurn(request('Nogita, what does 429 mean', 'e1'));
  await router.acceptCompletedTurn(request('Nogita, what does 429 mean?', 'f1'));
  assert.deepEqual(started, ['Nogita, what does 429 mean']);
  assert.ok(contexts[0]!.speculation);
  assert.deepEqual(cancelled, []);

  // The speaker went on: rolled back at once.
  router.acceptEagerTurn(request('Nogita, what is the status of', 'e2'));
  router.resumeTurn('s', 'a');
  assert.deepEqual(cancelled, ['Nogita, what is the status of']);

  // Different words at the end of the turn: the early start is dropped and the full turn goes on without it.
  router.acceptEagerTurn(request('Nogita, open a task', 'e3'));
  await router.acceptCompletedTurn(request('Nogita, open a task for Dana', 'f3'));
  assert.deepEqual(cancelled, ['Nogita, what is the status of', 'Nogita, open a task']);
  assert.equal(contexts.at(-1)!.speculation, undefined);

  // Talk that is not to Nogita never starts early.
  router.acceptEagerTurn(request('I think we should ship it', 'e4'));
  assert.equal(started.length, 3);
});

test('a turn that is only her name waits for the question that follows', async () => {
  const f = fixture(); f.router.beginSession('s');
  void f.router.acceptCompletedTurn(f.request('a', 'Nogita.', 'n1', owner));
  assert.equal(f.emitted.length, 0);
  void f.router.acceptCompletedTurn(f.request('a', 'What was the last commit about?', 'n2', owner));
  await f.flush();
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]!.utterance.text, 'Nogita. What was the last commit about?');
});
