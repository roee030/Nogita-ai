import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechFloor } from '../src/core/speech-floor.ts';

test('explicit turn-end mode never speaks after a talking lease expires', async () => {
  let now = 0;
  const scheduled: Array<() => void> = [];
  const said: string[] = [];
  const floor = new SpeechFloor({
    now: () => now,
    schedule: work => { scheduled.push(work); return work; },
    cancel: () => undefined,
    talkingMs: 10,
    explicitTurnEnd: true,
    speak: async text => { said.push(text); return 'spoken'; },
  });

  floor.noteTalking('speaker-b');
  const answer = floor.say(1, 'I will wait for the room.');
  now = 10_000;
  scheduled.shift()?.();
  await Promise.resolve();

  assert.deepEqual(said, []);
  floor.noteTalking('speaker-b', true);
  assert.equal(await answer, 'spoken');
  assert.deepEqual(said, ['I will wait for the room.']);
});

test('the legacy floor still opens when the talking lease expires', async () => {
  let now = 0;
  const scheduled: Array<() => void> = [];
  const said: string[] = [];
  const floor = new SpeechFloor({
    now: () => now,
    schedule: work => { scheduled.push(work); return work; },
    cancel: () => undefined,
    talkingMs: 10,
    speak: async text => { said.push(text); return 'spoken'; },
  });

  floor.noteTalking('speaker-b');
  const answer = floor.say(1, 'Legacy behavior.');
  now = 10;
  scheduled.shift()?.();

  assert.equal(await answer, 'spoken');
  assert.deepEqual(said, ['Legacy behavior.']);
});
