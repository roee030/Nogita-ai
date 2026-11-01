import test from 'node:test';
import assert from 'node:assert/strict';
import { isReasoningAloud, isRepeatRequest, refersToSelfInThirdPerson, stripReasoningAloud, stripRepeatRequests } from '../src/core/speech-guard.ts';

// Said aloud in the voice lab (2026-10-31 broad baselines): the model's deliberation, not an answer.
const deliberation = [
  "Avi is addressing Roy, not me, so I'll stay quiet on this one.",
  'About the flaky test on main, an empty reply is the right call here, since this was meant for Roy.',
  "This is a follow-up that mentions the client leaving early, but it's a direct question to me about the code, so I'll answer it.",
  "This message is addressed to me by name, so I'll look up the Jira idempotency handling.",
  'The search hits point at the engine as the core of meetings, but I want to confirm the entry point before naming a file.',
  "That wasn't directed at me.",
  "I'll stay out of this one.",
  'This question is about the retry logic, so I should check the worker first.',
  "The config has a project key field, so I need to see where it's set.",
  // Live Meet 2026-10-31.
  "All the is garbled, and I can't tell what tasks he wants.",
  'Ask him once briefly,',
  "My last answer about four merges today wasn't backed by a lookup I actually ran, so I can't open tasks.",
];

const answers = [
  'Mostly in the Jira adapter, jira.ts.',
  "Yeah, the retry's in the worker, it backs off three times.",
  'Avi asked about this in the PR yesterday; it was merged this morning.',
  "It's addressed in KAN 31, the cache headers task.",
  'The request goes to the payments service first, then the ledger.',
  "Let me check the board.",
  "Sure, about what?",
  'Not sure, let me look.',
  'The message queue retries it five times before it gives up.',
  'Nope, that one is still open.',
  "Quiet hours start at ten, so I'll post it tomorrow morning.",
  'The token expires hourly, so you need to refresh it.',
  'I need to see the logs first; can you paste them?',
  "I can't tell what the retry limit is from the config.",
  'Ask the payments team; they own that queue.',
];

test('deliberation said aloud is recognized', () => {
  for (const sentence of deliberation) assert.equal(isReasoningAloud(sentence), true, sentence);
});

test('real answers and short lead-ins are never dropped', () => {
  for (const sentence of answers) assert.equal(isReasoningAloud(sentence), false, sentence);
});

test('stripping keeps the answer and drops only the deliberation', () => {
  assert.equal(stripReasoningAloud("This message is addressed to me by name, so I'll look it up. It's in jira.ts."), "It's in jira.ts.");
  assert.equal(stripReasoningAloud("Avi is addressing Roy, not me, so I'll stay quiet on this one."), '');
  assert.equal(stripReasoningAloud('Mostly in the Jira adapter. Each request ID gets a hash.'), 'Mostly in the Jira adapter. Each request ID gets a hash.');
  assert.equal(stripReasoningAloud(''), '');
});

test('talking about herself as "Nogita" or "it" is caught', () => {
  assert.equal(refersToSelfInThirdPerson('Nogita speaks only when someone addresses it by name.'), true);
  assert.equal(refersToSelfInThirdPerson('Nogita answers only when called by name.'), true);
  assert.equal(refersToSelfInThirdPerson('I speak only when someone says my name.'), false);
  assert.equal(refersToSelfInThirdPerson('The Nogita repo has a Dockerfile.'), false);
});

test('asking the room to repeat is recognized; answers that mention cuts or repeats are not', () => {
  for (const sentence of ['The rest of what you said cut out, so I\'m not sure what you\'re asking about the client demo.',
    'Sounds like the sentence got cut off again.', "Sorry, I didn't catch that.", 'Could you say that again?',
    'Can you repeat the question?', 'What were you asking?']) assert.equal(isRepeatRequest(sentence), true, sentence);
  for (const sentence of ['The retry loop repeats three times.', 'The cutover is on Thursday.', 'It cuts the payload at 14,000 characters.',
    'Repeat offenders get rate-limited.']) assert.equal(isRepeatRequest(sentence), false, sentence);
  assert.equal(stripRepeatRequests("Sounds like that got cut off. It's engine.test.ts."), "It's engine.test.ts.");
});
