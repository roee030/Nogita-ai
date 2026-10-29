import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine, isCancelCommand, isStopCommand, type QuestionEvent } from '../src/core/engine.ts';
import { SpeechFloor, type SpeakOutcome } from '../src/core/speech-floor.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const roee = { id: 'roee', displayName: 'Roee', verified: true };
const dana = { id: 'dana', displayName: 'Dana', verified: true };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await sleep(5);
  }
}

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }>; delayMs?: number };
/** Answers by question: each route's steps follow the tool rounds of that conversation; topic requests get `topic`. */
class RoutedModel implements ChatModel {
  readonly agentModel = 'routed';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly routes: Array<{ match: RegExp; topic?: string; steps: Step[] }>) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    const first = String(request.messages[0]?.content ?? '');
    const route = this.routes.find(candidate => candidate.match.test(first.split('says to you now:').at(-1) ?? first));
    if (request.stableSystem.startsWith('Name the topic')) {
      return { content: [{ type: 'text', text: route?.topic ?? 'that' }], stopReason: 'end_turn' };
    }
    const step = route?.steps[request.messages.filter(message => message.role === 'assistant').length] ?? { text: '' };
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
    }
    const content: AgentContent[] = [];
    if (step.text) {
      for (const piece of step.text.match(/.{1,9}/gs) ?? []) onText(piece);
      content.push({ type: 'text', text: step.text });
    }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

/** Speech takes a little time, like playback; `interruptAt` cuts off the nth spoken piece (1-based). */
class VoiceMeeting extends DemoMeeting {
  readonly spoken: string[] = [];
  interruptAt?: number;
  speaking = 0;
  override async speak(message: string): Promise<void> {
    this.spoken.push(message);
    this.speaking++;
    try {
      await sleep(15);
      if (this.spoken.length === this.interruptAt) throw new Error('speech interrupted by participant');
      this.events.push({ type: 'speak', text: message });
    } finally { this.speaking--; }
  }
}

function fixture(model: ChatModel, board = new DemoBoard()) {
  const meeting = new VoiceMeeting('m');
  const questions: QuestionEvent[] = [];
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, onQuestion: (_s, event) => questions.push(event),
    floor: { resumeAfterMs: 60, talkingMs: 60, staleLeadInMs: 2_000 } });
  const statuses = (id: number) => questions.filter(event => event.id === id).map(event => event.status);
  return { engine, meeting, board, questions, statuses };
}

test('stop and cancel commands are recognized only as whole short commands', () => {
  for (const text of ['stop', 'Stop.', 'okay, stop', 'wait', 'hold on', 'stop talking']) assert.ok(isStopCommand(text), text);
  for (const text of ['never mind', 'Actually, never mind.', 'forget it', 'cancel that', 'scratch that', 'nevermind, I found it'])
    assert.ok(isCancelCommand(text), text);
  for (const text of ['stop the deploy', 'what about the, uh... actually, never mind.', 'wait, what is the status of KAN-4?'])
    assert.ok(!isStopCommand(text) && !isCancelCommand(text), text);
});

test('two people ask before either answer is ready: both answered, in turn, each naming its topic', async () => {
  const model = new RoutedModel([
    { match: /login bug/, topic: 'the login bug', steps: [
      { text: 'Checking the board.', tools: [{ name: 'search_code', input: { query: 'login' } }] },
      { text: 'It is still open and waiting for QA.', delayMs: 150 },
    ] },
    { match: /Yossi/, topic: "Yossi's PR", steps: [
      { text: 'Checking that too.', tools: [{ name: 'search_code', input: { query: 'yossi' } }] },
      { text: "About Yossi's PR, it is approved but not merged yet.", delayMs: 20 },
    ] },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: "Nogita, what's the status of the login bug?", eventId: '1', actor: roee });
  await until(() => f.meeting.spoken.length >= 1);
  const second = f.engine.onUtterance('s', { text: "Nogita, and what about Yossi's PR?", eventId: '2', actor: dana });
  await Promise.all([first, second]);
  const spoken = f.meeting.spoken;
  assert.deepEqual(spoken.slice(0, 2), ['Checking the board.', 'Checking that too.']);
  assert.ok(spoken.includes("About Yossi's PR, it is approved but not merged yet."));
  assert.ok(spoken.includes('About the login bug, it is still open and waiting for QA.'), spoken.join(' | '));
  assert.equal(spoken.length, 4);
  // The second question's prompt knew about the first one and was asked to name its topic.
  const danaRequest = model.requests.find(request => /Yossi/.test(String(request.messages[0]?.content)) && request.turnSystem)!;
  assert.match(danaRequest.turnSystem, /Roee: "what's the status of the login bug\?"/);
  assert.deepEqual(f.statuses(1).at(-1), 'answered');
  assert.deepEqual(f.statuses(2).at(-1), 'answered');
  const chats = f.meeting.events.filter(event => event.type === 'chat').map(event => event.text);
  assert.ok(chats.includes('About the login bug: It is still open and waiting for QA.'));
});

test('an answer cut off by a participant is finished afterwards, not lost', async () => {
  const model = new RoutedModel([{ match: /cache/, steps: [
    { text: 'The cache keeps entries for five minutes. After that they are fetched again from the source.' },
  ] }]);
  const f = fixture(model);
  f.meeting.interruptAt = 1;
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Nogita, how long does the cache keep things?', eventId: '1', actor: roee });
  assert.equal(f.meeting.spoken[0], 'The cache keeps entries for five minutes.');
  // Repeated once the room was quiet again; the second sentence followed.
  assert.equal(f.meeting.spoken[1], 'The cache keeps entries for five minutes.');
  assert.match(f.meeting.spoken.join(' '), /fetched again from the source/);
  assert.deepEqual(f.statuses(1), ['working', 'answering', 'interrupted', 'answering', 'answered']);
});

test('"Nogita, stop" after a cut-off ends the answer; chat still has it', async () => {
  const model = new RoutedModel([{ match: /cache/, steps: [
    { text: 'The cache keeps entries for five minutes. After that they are fetched again from the source.' },
  ] }]);
  const f = fixture(model);
  f.meeting.interruptAt = 1;
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, how long does the cache keep things?', eventId: '1', actor: roee });
  await until(() => f.meeting.spoken.length === 1 && f.meeting.speaking === 0);
  assert.equal(await f.engine.onUtterance('s', { text: 'Nogita, stop.', eventId: '2', actor: dana }), 'answered');
  await first;
  await sleep(100);
  assert.equal(f.meeting.spoken.length, 1);
  assert.equal(f.statuses(1).at(-1), 'stopped');
  assert.ok(f.meeting.events.some(event => event.type === 'chat' && /fetched again/.test(event.text ?? '')));
});

test('"never mind" drops the open lookup: no answer spoken, said once, and noted in chat', async () => {
  const model = new RoutedModel([{ match: /sprint/, steps: [
    { text: 'Let me check the board.', tools: [{ name: 'search_code', input: { query: 'sprint' } }] },
    { text: 'There are four tasks left in the sprint.', delayMs: 300 },
  ] }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, how many tasks are left in the sprint?', eventId: '1', actor: roee });
  await until(() => f.meeting.spoken.length === 1 && f.meeting.speaking === 0);
  assert.equal(await f.engine.onUtterance('s', { text: 'Actually, never mind.', eventId: '2', actor: roee }), 'answered');
  assert.equal(await first, 'ignored');
  await sleep(50);
  assert.deepEqual(f.meeting.spoken, ['Let me check the board.', 'Okay, dropping that.']);
  assert.equal(f.statuses(1).at(-1), 'cancelled');
  assert.ok(f.meeting.events.some(event => event.type === 'chat' && /^Dropped the question/.test(event.text ?? '')));
});

test('the same question asked again while it is open starts no second lookup', async () => {
  const model = new RoutedModel([{ match: /release/, steps: [
    { text: 'The release is on Thursday.', delayMs: 120 },
  ] }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, when is the release?', eventId: '1', actor: roee });
  await sleep(20);
  assert.equal(await f.engine.onUtterance('s', { text: 'Nogita, when is the release?', eventId: '2', actor: roee }), 'ignored');
  await first;
  assert.equal(model.requests.filter(request => request.tools.length).length, 1);
  assert.equal(f.meeting.spoken.filter(text => /Thursday/.test(text)).length, 1);
});

test('speculative start: confirmed words reuse the early answer; nothing is said before confirmation', async () => {
  const model = new RoutedModel([{ match: /429/, steps: [{ text: 'It means too many requests.', delayMs: 30 }] }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  const utterance = { text: 'Nogita, what does 429 mean?', eventId: 'eager', actor: roee };
  const speculation = f.engine.speculate('s', utterance)!;
  assert.ok(speculation);
  await sleep(80);
  assert.equal(f.meeting.spoken.length, 0);
  assert.equal(await f.engine.onUtterance('s', { ...utterance, eventId: 'final' }, { speculation }), 'answered');
  assert.deepEqual(f.meeting.spoken, ['It means too many requests.']);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(f.statuses(1), ['speculative', 'working', 'answering', 'answered']);
});

test('speculative start rolled back: the speaker kept talking, so nothing is said or written', async () => {
  const model = new RoutedModel([{ match: /task/, steps: [
    { text: 'Creating it.', tools: [{ name: 'create_task', input: { title: 'Fix login', description: 'From the meeting.' } }] },
    { text: 'Done.' },
  ] }]);
  const board = new DemoBoard();
  const f = fixture(model, board);
  await f.engine.startSession('s', f.meeting);
  const speculation = f.engine.speculate('s', { text: 'Nogita, create a task to fix login', eventId: 'eager', actor: roee })!;
  await sleep(40);
  speculation.cancel();
  await sleep(40);
  assert.equal(board.tasks.length, 0);
  assert.equal(f.meeting.spoken.length, 0);
  assert.equal(f.statuses(1).at(-1), 'rolled_back');
  // The full sentence is a different request: answered fresh, the task created once.
  await f.engine.onUtterance('s', { text: 'Nogita, create a task to fix login on Safari', eventId: 'final', actor: roee }, { speculation });
  assert.equal(board.tasks.length, 1);
});

test('floor: waits for a talking person, never interleaves two answers, skips a stale lead-in', async () => {
  const said: string[] = [];
  let now = 0;
  const floor = new SpeechFloor({ now: () => now, schedule: () => 0, cancel: () => undefined,
    speak: async (text): Promise<SpeakOutcome> => { said.push(text); return 'spoken'; } });
  floor.noteTalking('dana');
  const a1 = floor.say(1, 'A first.');
  await sleep(1);
  assert.deepEqual(said, []);
  floor.noteTalking('dana', true);
  await a1;
  // A is mid-answer: B waits until A's answer is complete.
  const b = floor.say(2, 'B answer.');
  await floor.say(1, 'A second.');
  assert.deepEqual(said, ['A first.', 'A second.']);
  floor.release(1);
  await b;
  assert.deepEqual(said, ['A first.', 'A second.', 'B answer.']);
  floor.release(2);
  now = 10_000;
  floor.noteTalking('avi');
  const lead = floor.say(3, 'Let me check.', { leadIn: true });
  now = 14_000;
  floor.noteTalking('avi', true);
  assert.equal(await lead, 'dropped');
});

test('the asker cuts off their own answer with a new question: the old one is not resumed (it is in chat)', async () => {
  const model = new RoutedModel([
    { match: /503/, steps: [{ text: 'HTTP 503 means the service is unavailable. It is usually temporary.' }] },
    { match: /504/, steps: [{ text: '504 means a gateway timed out.' }] },
  ]);
  const f = fixture(model);
  f.meeting.interruptAt = 1;
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, what does 503 mean?', eventId: '1', actor: roee });
  await until(() => f.meeting.spoken.length === 1 && f.meeting.speaking === 0);
  await f.engine.onUtterance('s', { text: 'Nogita, and 504?', eventId: '2', actor: roee });
  await first;
  assert.deepEqual(f.meeting.spoken, ['HTTP 503 means the service is unavailable.', '504 means a gateway timed out.']);
  assert.equal(f.statuses(1).at(-1), 'chat_only');
  assert.ok(f.meeting.events.some(event => event.type === 'chat' && /usually temporary/.test(event.text ?? '')));
});

test('only her name: no answer yet, and the same speaker\'s next words are the question', async () => {
  const model = new RoutedModel([{ match: /last commit/, steps: [{ text: 'It added the speech floor.' }] }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.engine.onUtterance('s', { text: 'Nogita.', eventId: '1', actor: roee }), 'ignored');
  assert.equal(model.requests.length, 0);
  assert.equal(await f.engine.onUtterance('s', { text: 'What was the last commit about?', eventId: '2', actor: roee }), 'answered');
  assert.deepEqual(f.meeting.spoken, ['It added the speech floor.']);
});

test('a lead-in cut off by a participant is not repeated', async () => {
  const model = new RoutedModel([{ match: /board/, steps: [
    { text: 'Checking the board.', tools: [{ name: 'search_code', input: { query: 'board' } }] },
    { text: 'One task is in progress.', delayMs: 100 },
  ] }]);
  const f = fixture(model);
  f.meeting.interruptAt = 1;
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: "Nogita, what's on the board?", eventId: '1', actor: roee });
  assert.deepEqual(f.meeting.spoken, ['Checking the board.', 'One task is in progress.']);
});

test('the speaker goes on after a pause: the answer to the first half is dropped and the whole question answered', async () => {
  const model = new RoutedModel([
    { match: /server/, steps: [{ text: 'The server starts in src/app/server.ts.' }] },
    { match: /can you check\?$/, steps: [{ text: 'What should I check?', delayMs: 150 }] },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, can you check?', eventId: '1', actor: roee });
  await sleep(30);
  await f.engine.onUtterance('s', { text: 'which file starts the server?', eventId: '2', actor: roee });
  await first;
  assert.deepEqual(f.meeting.spoken, ['The server starts in src/app/server.ts.']);
  assert.equal(f.statuses(1).at(-1), 'superseded');
  assert.equal(f.statuses(2).at(-1), 'answered');
});

test('"Stop." then a new request without her name: she stops and answers the request', async () => {
  const model = new RoutedModel([
    { match: /meeting works/, steps: [{ text: 'First the bot joins. Then it listens for its name. Then it answers.' }] },
    { match: /main file/, steps: [{ text: 'It is src/core/engine.ts.' }] },
  ]);
  const f = fixture(model);
  f.meeting.interruptAt = 1;
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, walk me through how a meeting works.', eventId: '1', actor: roee });
  await until(() => f.meeting.spoken.length === 1 && f.meeting.speaking === 0);
  assert.equal(await f.engine.onUtterance('s', { text: 'Nogita, stop.', eventId: '2', actor: roee }), 'answered');
  assert.equal(await f.engine.onUtterance('s', { text: 'Just tell me the name of the main file.', eventId: '3', actor: roee }), 'answered');
  await first;
  assert.deepEqual(f.meeting.spoken, ['First the bot joins.', 'It is src/core/engine.ts.']);
});
