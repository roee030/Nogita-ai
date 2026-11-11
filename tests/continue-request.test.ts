// P9-26: in the Meet of 11 November Roee went on talking while she answered; she kept speaking, then answered again.
// With NOGITA_CONTINUE_REQUEST she stops, adds his words to his open request and answers it all once.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { CONTINUE_ACK, NogitaEngine, hebrewVoiceCommand, type QuestionEvent } from '../src/core/engine.ts';
import { SpeechInterruptedError } from '../src/core/contracts.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { continueRequest } from '../src/app/config.ts';

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
/** Picks the steps by what the person said this turn; every request is kept to check what the agent was asked. */
class Model implements ChatModel {
  readonly agentModel = 'scripted';
  readonly asked: string[] = [];
  constructor(private readonly route: (said: string) => Step[]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.stableSystem.startsWith('Name the topic')) return { content: [{ type: 'text', text: 'that' }], stopReason: 'end_turn' };
    const first = String(request.messages[0]?.content ?? '');
    const said = first.split('says to you now:').at(-1) ?? first;
    if (!request.messages.some(message => message.role === 'assistant')) this.asked.push(said);
    const step = this.route(said)[request.messages.filter(message => message.role === 'assistant').length] ?? { text: '' };
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
    }
    const content: AgentContent[] = [];
    if (step.text) { onText(step.text); content.push({ type: 'text', text: step.text }); }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

/** Playback takes `speakMs`; interruptSpeech() cuts the piece playing, like the realtime audio. */
class VoiceMeeting extends DemoMeeting {
  readonly spoken: string[] = [];
  readonly heard: string[] = [];
  speakMs = 15;
  private stopNow?: () => void;
  get playing(): boolean { return this.stopNow !== undefined; }
  override async speak(message: string): Promise<void> {
    this.spoken.push(message);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.stopNow = undefined; resolve(); }, this.speakMs);
      this.stopNow = () => { clearTimeout(timer); this.stopNow = undefined; reject(new SpeechInterruptedError()); };
    });
    this.heard.push(message);
  }
  interruptSpeech(): boolean {
    if (!this.stopNow) return false;
    this.stopNow();
    return true;
  }
}

function fixture(model: Model, on: boolean) {
  const meeting = new VoiceMeeting('m');
  const board = new DemoBoard();
  const questions: QuestionEvent[] = [];
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, onQuestion: (_s, event) => questions.push(event),
    floor: { resumeAfterMs: 60, talkingMs: 20, staleLeadInMs: 2_000 }, continueRequest: on });
  const statuses = (id: number) => questions.filter(event => event.id === id).map(event => event.status);
  return { engine, meeting, board, statuses };
}

const say = (f: ReturnType<typeof fixture>, text: string, eventId: string, actor = roee) =>
  f.engine.onUtterance('s', { text, eventId, actor }, { speakerKey: actor.id, turnEnded: true });

const LONG = 'Four pull requests merged in the last three days. Nine commits, all on main.';

test('flag parses true and false, off by default', () => {
  assert.equal(continueRequest({}), false);
  assert.equal(continueRequest({ NOGITA_CONTINUE_REQUEST: 'true' }), true);
  assert.equal(continueRequest({ NOGITA_CONTINUE_REQUEST: 'false' }), false);
  assert.throws(() => continueRequest({ NOGITA_CONTINUE_REQUEST: 'yes' }));
});

test('Hebrew stop and cancel are recognized as whole commands only', () => {
  for (const text of ['עצרי', 'נוגיטה, עצרי.', 'די', 'רגע, מספיק']) assert.equal(hebrewVoiceCommand(text), 'stop', text);
  for (const text of ['בטלי', 'תבטלי את זה', 'לא משנה', 'עזבי']) assert.equal(hebrewVoiceCommand(text), 'cancel', text);
  for (const text of ['עצרי את הדיפלוי', 'מה לא משנה בקוד?', 'בטלי את המשימה KAN-4']) assert.equal(hebrewVoiceCommand(text), undefined, text);
});

const routes = (said: string): Step[] =>
  /tests/.test(said) ? [{ text: 'Four PRs merged, and the tests on main are green.' }] : [{ text: LONG }];

test('continuing while she is speaking: she stops, says she will answer the full question, and answers it once', async () => {
  const model = new Model(routes);
  const f = fixture(model, true);
  f.meeting.speakMs = 400;
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
  await until(() => f.meeting.playing);
  // The live words reach her before the turn is over: she yields to the asker at once.
  assert.equal(f.engine.yieldsTo('s', 'roee', 'and also'), true);
  assert.equal(f.engine.yieldsTo('s', 'dana', 'and also'), false);
  assert.equal(f.engine.yieldsTo('s', 'roee', 'okay'), false);
  f.meeting.interruptSpeech();
  f.meeting.speakMs = 10;
  await say(f, 'and are the tests on main green?', '2');
  await first;
  await until(() => f.meeting.heard.length >= 2);
  assert.deepEqual(f.meeting.heard, [CONTINUE_ACK, 'Four PRs merged, and the tests on main are green.']);
  assert.equal(f.statuses(1).at(-1), 'superseded');
  assert.equal(f.statuses(2).at(-1), 'answered');
  assert.match(model.asked.at(-1)!, /merge in the last three days\? and are the tests on main green\?/);
});

test('flag off: the same interruption gets no "full question" acknowledgement and live words never stop her', async () => {
  const f = fixture(new Model(routes), false);
  f.meeting.speakMs = 400;
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
  await until(() => f.meeting.playing);
  assert.equal(f.engine.yieldsTo('s', 'roee', 'and are the tests'), false);
  f.meeting.interruptSpeech();
  f.meeting.speakMs = 10;
  await say(f, 'and are the tests on main green?', '2');
  await first;
  assert.ok(!f.meeting.spoken.includes(CONTINUE_ACK));
});

test('continuing while she is still looking it up: the first lookup is dropped and the whole request answered', async () => {
  const model = new Model(said => /tests/.test(said) ? [{ text: 'Four PRs, tests green.' }] : [{ text: LONG, delayMs: 300 }]);
  const f = fixture(model, true);
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
  await sleep(30);
  await say(f, 'and are the tests on main green?', '2');
  await first;
  await until(() => f.meeting.heard.length >= 2);
  assert.deepEqual(f.meeting.heard, [CONTINUE_ACK, 'Four PRs, tests green.']);
  assert.equal(f.statuses(1).at(-1), 'superseded');
});

test('a correction replaces what it corrects', async () => {
  const model = new Model(said => /corrected/.test(said) ? [{ text: 'The mobile app has two open bugs.' }] : [{ text: 'The web app has five.', delayMs: 300 }]);
  const f = fixture(model, true);
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, how many bugs are open in the web app?', '1');
  await sleep(30);
  await say(f, 'no, I meant the mobile app', '2');
  await first;
  await until(() => f.meeting.heard.length >= 2);
  assert.deepEqual(f.meeting.heard, [CONTINUE_ACK, 'The mobile app has two open bugs.']);
  assert.match(model.asked.at(-1)!, /then corrected: "no, I meant the mobile app"/);
});

test('"okay" while she speaks is a backchannel: nothing is added and the answer goes on', async () => {
  for (const backchannel of ['okay', 'yeah', 'בסדר']) {
    const model = new Model(routes);
    const f = fixture(model, true);
    f.meeting.speakMs = 60;
    await f.engine.startSession('s', f.meeting);
    const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
    await until(() => f.meeting.playing);
    assert.equal(f.engine.yieldsTo('s', 'roee', backchannel), false, backchannel);
    await say(f, backchannel, '2');
    await first;
    assert.equal(f.meeting.heard.join(' '), LONG, backchannel);
    assert.equal(f.statuses(1).at(-1), 'answered', backchannel);
    assert.equal(model.asked.length, 1, backchannel);
  }
});

test('"stop" and "עצרי" end the answer; "cancel" and "בטלי" drop it; none is answered again', async () => {
  for (const [command, status] of [['stop', 'stopped'], ['עצרי', 'stopped'], ['never mind', 'cancelled'], ['בטלי', 'cancelled']] as const) {
    const model = new Model(routes);
    const f = fixture(model, true);
    f.meeting.speakMs = 400;
    await f.engine.startSession('s', f.meeting);
    const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
    await until(() => f.meeting.playing);
    assert.equal(f.engine.yieldsTo('s', 'roee', command), true, command);
    assert.equal(await say(f, command, '2'), 'answered', command);
    await first;
    await sleep(80);
    assert.equal(f.statuses(1).at(-1), status, command);
    assert.ok(!f.meeting.spoken.includes(CONTINUE_ACK), command);
    assert.equal(model.asked.length, 1, command);
    assert.ok(!f.meeting.heard.join(' ').includes('Nine commits'), command);
  }
});

test('another speaker talking during her answer is never added to the request', async () => {
  const model = new Model(said => /Dana|lunch/.test(said) ? [{ text: '' }] : [{ text: LONG, delayMs: 200 }]);
  const f = fixture(model, true);
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, what did we merge in the last three days?', '1');
  await sleep(30);
  await say(f, 'and are we getting lunch after this?', '2', dana);
  await first;
  await until(() => f.meeting.heard.length >= 2);
  assert.equal(f.meeting.heard.join(' '), LONG);
  assert.notEqual(f.statuses(1).at(-1), 'superseded');
  assert.ok(model.asked.every(said => !/merge in the last three days.*lunch/s.test(said)));
});

test('an interruption never repeats a write: the task made before it is found done, not made again', async () => {
  const create = { name: 'create_task', input: { title: 'Release notes', description: 'Write the release notes.' } };
  const model = new Model(said => /Yossi/.test(said)
    ? [{ tools: [create] }, { text: 'DEMO-1 is there; I assigned nothing new.' }]
    : [{ tools: [create] }, { text: 'Created DEMO-1, the release notes task. It is on the board now for anyone to pick up.' }]);
  const f = fixture(model, true);
  f.meeting.speakMs = 400;
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, create a task for the release notes.', '1');
  await until(() => f.meeting.playing);
  assert.equal(f.board.tasks.length, 1);
  f.meeting.interruptSpeech();
  f.meeting.speakMs = 10;
  await say(f, 'and tell Yossi about it', '2');
  await first;
  await until(() => f.meeting.heard.includes('DEMO 1 is there; I assigned nothing new.'));
  // The second run called create_task again; the write key of the first request found it already done.
  assert.equal(f.board.tasks.length, 1);
  assert.match(model.asked.at(-1)!, /Already done for this request; do not do it again: DEMO-1/);
});
