import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopCommand } from '../src/core/engine.ts';
import { directlyAddressesNogita, normalizeWakeWord } from '../src/core/policy.ts';

test('"stop" as people say it while she talks over them (first live Meet test)', () => {
  for (const text of ['Stop stop for a second!', 'Nogitas nogita stop!', 'Stop speaking.', "Hello, I'm talking to you stop.",
    'stop', 'Okay, wait.', 'Be quiet please.']) {
    assert.equal(isStopCommand(text), true, text);
  }
  for (const text of ['How do I stop the server?', "Don't stop, go on.", 'Stop the deployment pipeline for the payments service right now please okay',
    'We should stop the retries after three attempts.']) {
    assert.equal(isStopCommand(text), false, text);
  }
});

test('her name as recognition heard it in the live Meet still addresses her', () => {
  for (const text of ['Uh, no guitar. I want to know what is open.', 'No, Gita. Verify 429480.', 'Now, git, are you here?']) {
    assert.equal(directlyAddressesNogita(normalizeWakeWord(text)), true, text);
  }
  assert.equal(directlyAddressesNogita(normalizeWakeWord('I play no guitar at all.')), false);
});
