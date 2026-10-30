import test from 'node:test';
import assert from 'node:assert/strict';
import { PhrasePicker, toSpoken } from '../src/core/spoken.ts';

test('spoken: names written for the eye become what a colleague would say', () => {
  assert.equal(toSpoken('The main file is src/app/server.ts, which wires it together.'), 'The main file is server.ts, which wires it together.');
  assert.equal(toSpoken('Look at ./src/core/engine.ts and tests/leave.test.ts.'), 'Look at engine.ts and leave.test.ts.');
  assert.equal(toSpoken('KAN-20 is unassigned.'), 'KAN 20 is unassigned.');
  assert.equal(toSpoken('The recentCommits tool reads retry_worker.'), 'The recent commits tool reads retry worker.');
  // Left alone: versions, decimals, product names, a lone file name.
  assert.equal(toSpoken('Use Node 22.16 on macOS and iOS; it takes 3.5 seconds.'), 'Use Node 22.16 on macOS and iOS; it takes 3.5 seconds.');
  assert.equal(toSpoken('The file is README.md.'), 'The file is README.md.');
});

test('spoken: chatbot openers are dropped, real answers are kept', () => {
  assert.equal(toSpoken('Certainly! The retry runs three times.'), 'The retry runs three times.');
  assert.equal(toSpoken('Great question. It lives in the worker.'), 'It lives in the worker.');
  assert.equal(toSpoken("I'd be happy to help with that. It's in the worker."), "It's in the worker.");
  assert.equal(toSpoken('It is fast. Of course, it needs a cache.'), 'It is fast. It needs a cache.');
  assert.equal(toSpoken('Absolutely not, that would break it.'), 'Absolutely not, that would break it.');
});

test('spoken: markdown and links never reach the voice', () => {
  assert.equal(toSpoken('**Yes**, see [the PR](https://github.com/x/y/pull/1) and `retry()`.'), 'Yes, see the PR and retry().');
});

test('phrase picker never repeats one of the last few phrases', () => {
  const picker = new PhrasePicker(() => 0, 2);
  const phrases = ['a', 'b', 'c'];
  const picked = Array.from({ length: 6 }, () => picker.pick(phrases));
  for (let i = 1; i < picked.length; i++) assert.notEqual(picked[i], picked[i - 1]);
  assert.deepEqual(picked.slice(0, 3).sort(), ['a', 'b', 'c']);
});

test('spoken: no announcer openers and no plan narration', () => {
  assert.equal(toSpoken('Short version: every request is tied to a verified identity.'), 'Every request is tied to a verified identity.');
  assert.equal(toSpoken("I'll check the identity and policy code to answer that accurately."), "I'll check the identity and policy code.");
  assert.equal(toSpoken("I'll pull up the lifecycle code so I get this right."), "I'll pull up the lifecycle code.");
});

test('spoken: no thinking out loud about the question', () => {
  assert.equal(toSpoken("This is a question about the team's code, so I'll check the implementation."), "I'll check the implementation.");
  assert.equal(toSpoken('Let me pull the architecture doc so I can give you an accurate answer.'), 'Let me pull the architecture doc.');
});
