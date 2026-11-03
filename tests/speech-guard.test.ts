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

// P5-16: planning aloud and empty "in the chat" claims from the live Meet of 2026-11-01.
import { claimsChat, isPlanningAloud, stripChatClaims, stripPlanningAloud } from '../src/core/speech-guard.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

const MEET_PLANNING = [
  'Roee wants a push to main.',
  "Roee wants the full list of today's merged PRs.",
  "Roee wants a combined summary of today's merged PRs.",
  'The earlier lookup covered them, but the spoken answer should be short.',
  "I'll answer with the count and the latest and point to the chat for the full list.",
];

test('planning aloud from the Meet is dropped; answers, and other people\'s wishes, stay', () => {
  for (const sentence of MEET_PLANNING) assert.equal(isPlanningAloud(sentence, 'Roee Angel'), true, sentence);
  for (const sentence of ['Dana wants it by Friday.', 'Yes, 36 PRs were merged to main today.', 'Roee, the latest is PR 75.',
    'The spoken part of the demo went well.'.replace('spoken part', 'demo'), 'I can answer that.'])
    assert.equal(isPlanningAloud(sentence, 'Roee Angel'), false, sentence);
  assert.equal(stripPlanningAloud(`${MEET_PLANNING.slice(1).join(' ')} Yes, 36 PRs were merged to main today.`, 'Roee Angel'),
    'Yes, 36 PRs were merged to main today.');
  assert.equal(claimsChat('Yep, there\'s a lot. I got the details in the chat.'), true);
  assert.equal(stripChatClaims("That's 128 commits and 36 merged PRs. I got the details in the chat."), "That's 128 commits and 36 merged PRs.");
});

class ScriptModel implements ChatModel {
  readonly agentModel = 'scripted';
  private index = 0;
  constructor(private readonly steps: Array<{ text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> }>) {}
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) { onText(step.text); content.push({ type: 'text', text: step.text }); }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}
class SpokenMeeting extends DemoMeeting {
  readonly spoken: string[] = [];
  override async speak(message: string, options?: { chatMirror?: boolean }): Promise<void> {
    this.spoken.push(message);
    void options;
    await super.speak(message);
  }
}
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };

async function speakWith(strict: boolean, steps: ConstructorParameters<typeof ScriptModel>[0], request: string) {
  const meeting = new SpokenMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: new ScriptModel(steps), people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, strictSpeechGuard: strict });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: request, eventId: '1', actor: roee });
  return meeting.spoken.join(' ');
}

test('with NOGITA_STRICT_SPEECH_GUARD the Meet answer is spoken without its planning or empty chat claim', async () => {
  const steps = [{ text: "Roee wants the full list of today's merged PRs. I'll answer with the count and the latest. Yes, 36 PRs were merged to main today. I got the details in the chat." }];
  const strict = await speakWith(true, steps, 'Nogita, please give me the details shortly, all the PRs that pushed?');
  assert.doesNotMatch(strict, /Roee wants|answer with|in the chat/);
  assert.match(strict, /36 PRs were merged/);
  const off = await speakWith(false, steps, 'Nogita, please give me the details shortly, all the PRs that pushed?');
  assert.match(off, /Roee wants/);
});

test('"the link is in the chat" stays when the turn really posted a receipt', async () => {
  const spoken = await speakWith(true, [
    { tools: [{ name: 'create_task', input: { title: "Today's merged PRs", description: 'd' } }] },
    { text: 'Done, KAN-24. The link is in the chat.' },
  ], "Nogita, create the Jira task for today's merged PRs.");
  assert.match(spoken, /The link is in the chat/);
});
