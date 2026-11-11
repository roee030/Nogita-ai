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
  // P9-25, Meet of 11 November.
  "Roee's question is cut off.",
  "Roee's last question was cut off: please explain in one sentence what.",
];

test('planning aloud from the Meet is dropped; answers, and other people\'s wishes, stay', () => {
  for (const sentence of MEET_PLANNING) assert.equal(isPlanningAloud(sentence, 'Roee Angel'), true, sentence);
  for (const sentence of ['Dana wants it by Friday.', 'Yes, 36 PRs were merged to main today.', 'Roee, the latest is PR 75.',
    'The spoken part of the demo went well.'.replace('spoken part', 'demo'), 'I can answer that.',
    "Dana's question is a good one.", 'Your question got cut off. Explain what, exactly?'])
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

test('planning aloud: saying why the words were not for her is dropped, a real answer is not', () => {
  for (const line of ["That was just an acknowledgement and not a request, so there's nothing for me to act on.",
    "Roee's question is directed at John's standup, not at me, and he's moved on to Evan.",
    'The request got cut off, so I need to know what he wants.', "I'll ask him in a few words.", '.',
    "I already have the summary from the earlier lookup, so I'll give the detail from that without another round."]) {
    assert.equal(stripPlanningAloud(line, 'Roee'), '', line);
  }
  for (const line of ['The alert is directed at the on-call team.', 'There is nothing on the board about the reset bug.', 'This was meant for staging, not production.', 'Dana owns it, so I would ask her first.', 'KAN-30.']) {
    assert.equal(stripPlanningAloud(line, 'Roee'), line, line);
  }
});

test('strict guard: sorting the request out loud is dropped, and ordinary answers that sound close stay', () => {
  for (const line of [
    'The user explicitly asked for a task assigned to Yossi, with a clear topic.',
    'The user asked me to work on this in the background, but they also said to open a task.',
    'This is a request to take ownership of KAN 3 and also to open a new task.',
    'This is a mission-style request.',
    "This one's a task to own, not a question, so I'll hand it to a mission.",
    'The request is to open a task for Yossi, so I will create it now.',
    'That fits delegate mission, but the explicit ask is to open a task.',
    'The clearest reading is to start a mission to handle KAN 3.',
    'I should create the task now, assigned to Yossi, rather than delegating.',
    'The person explicitly asked for a comment on KAN 1 with specific words, so I post it as written.',
    'The user asked to work on this in the background, so I should start a mission rather than create the task directly.',
    "Roee's request was explicit, so the tool refusing is odd.",
    'The previous turn offered that, and "Yeah. Do it." is an explicit request.',
    'The tool wants confirmation, but Roee already said yes.',
    "Nothing got created, so I shouldn't retry.",
    "I'll tell Roee plainly and ask him to say the request directly.",
  ]) assert.equal(stripPlanningAloud(line), '', line);
  for (const line of [
    'Creating it now.',
    'Done, KAN 7 is with Yossi.',
    'The user table has an email column.',
    'The user asked for a refund in KAN-12.',
    'The person asked to be moved to another team.',
    'This is a feature request from Dana.',
    'I should have it by Friday.',
    'The request is still open.',
  ]) assert.equal(stripPlanningAloud(line), line, line);
  assert.equal(stripPlanningAloud("Roee's asking for one task covering today's merged PRs.", 'Roee Angel'), '');
  assert.equal(stripPlanningAloud("Dana's asking for one task.", 'Roee Angel'), "Dana's asking for one task.");
  assert.equal(stripPlanningAloud('Got it. The request is to open a task for Yossi, so I will create it now. Done, KAN 7.'), 'Got it. Done, KAN 7.');
});

test('P9-25: the Meet of 11 November, "Roee\'s question is cut off", is not said aloud with the strict guard', async () => {
  const steps = [{ text: "Roee's question is cut off. Explain what, in one sentence?" }];
  const request = 'Please explain me nogita. Please explain in one sentence what?';
  const strict = await speakWith(true, steps, request);
  assert.doesNotMatch(strict, /Roee's question/);
  assert.match(strict, /Explain what, in one sentence\?/);
  assert.match(await speakWith(false, steps, request), /Roee's question/, 'off: as on 11 November');
});
