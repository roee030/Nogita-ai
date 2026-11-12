// P9-26: in the Meet of 11 November Roee went on talking while she answered; she kept speaking, then answered again.
// With NOGITA_CONTINUE_REQUEST she stops, adds his words to his open request and answers it all once.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { CONTINUE_ACK, NogitaEngine, hebrewVoiceCommand, looksLikeCorrection, looksLikeHebrewCorrection, type QuestionEvent } from '../src/core/engine.ts';
import { SpeechInterruptedError } from '../src/core/contracts.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { continueRequest } from '../src/app/config.ts';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, createAttendeeAudioSocketUrl, type SttMode } from '../src/app/attendee-realtime-audio.ts';
import { continueOnInterim } from '../src/app/continue-barge-in.ts';

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

test('Hebrew and mixed corrections are recognized; a sentence that only contains "לא" is not', () => {
  for (const text of ['לא, התכוונתי לאפליקציה במובייל', 'לא התכוונתי לשרת, אלא לאפליקציה', 'סליחה, התכוונתי ל-staging',
    'בעצם, אני שואלת על המובייל', 'no, התכוונתי ל-mobile app', 'לא, I meant the mobile app', 'לא, לא זה, אלא המובייל']) {
    assert.equal(looksLikeHebrewCorrection(text), true, text);
  }
  for (const text of ['לא הבנתי למה הבילד נכשל', 'למה הבילד לא עובר?', 'וגם תבדקי שאין באגים לא סגורים', 'לא משנה',
    'לא', 'and also the tests']) {
    assert.equal(looksLikeHebrewCorrection(text), false, text);
  }
  // Without the flag nothing changes: the English check never knew Hebrew.
  assert.equal(looksLikeCorrection('לא, התכוונתי לאפליקציה במובייל'), false);
});

for (const [name, correction] of [['Hebrew', 'לא, התכוונתי לאפליקציה במובייל'], ['mixed', 'no, התכוונתי ל-mobile app']] as const) {
  test(`a ${name} correction replaces what it corrects: "${correction}"`, async () => {
    const model = new Model(said => /corrected/.test(said) ? [{ text: 'The mobile app has two open bugs.' }] : [{ text: 'The web app has five.', delayMs: 300 }]);
    const f = fixture(model, true);
    await f.engine.startSession('s', f.meeting);
    const first = say(f, 'Nogita, how many bugs are open in the web app?', '1');
    await sleep(30);
    await say(f, correction, '2');
    await first;
    await until(() => f.meeting.heard.length >= 2);
    assert.deepEqual(f.meeting.heard, [CONTINUE_ACK, 'The mobile app has two open bugs.']);
    assert.ok(model.asked.at(-1)!.includes(`then corrected: "${correction}"`), model.asked.at(-1));
  });
}

test('a sentence with "לא" that is not a correction is added to the request, not treated as one', async () => {
  const model = new Model(said => /לא סגורים/.test(said) ? [{ text: 'Five, and none are unassigned.' }] : [{ text: 'The web app has five.', delayMs: 300 }]);
  const f = fixture(model, true);
  await f.engine.startSession('s', f.meeting);
  const first = say(f, 'Nogita, how many bugs are open in the web app?', '1');
  await sleep(30);
  await say(f, 'וגם תבדקי שאין באגים לא סגורים בלי בעלים', '2');
  await first;
  await until(() => f.meeting.heard.length >= 2);
  assert.deepEqual(f.meeting.heard, [CONTINUE_ACK, 'Five, and none are unassigned.']);
  assert.ok(model.asked.at(-1)!.includes('web app? וגם תבדקי שאין באגים לא סגורים בלי בעלים'), model.asked.at(-1));
  assert.ok(!model.asked.at(-1)!.includes('then corrected'));
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

test('a continuation that adds task B creates B once and never creates task A again', async () => {
  // The continued run follows the "already done" note and asks only for B: index-based keys used to hand it A's receipt.
  for (const repeatsA of [false, true]) {
    const a = { name: 'create_task', input: { title: 'Release notes', description: 'Write the release notes.' } };
    const aAgain = { name: 'create_task', input: { title: 'release notes.', description: 'Write the release notes.' } };
    const b = { name: 'create_task', input: { title: 'Changelog', description: 'Update the changelog.' } };
    const model = new Model(said => /changelog/.test(said)
      ? [{ tools: repeatsA ? [aAgain, b] : [b] }, { text: 'Both are on the board.' }]
      : [{ tools: [a] }, { text: 'Created DEMO-1, the release notes task. It is on the board now for anyone to pick up.' }]);
    const f = fixture(model, true);
    f.meeting.speakMs = 400;
    await f.engine.startSession('s', f.meeting);
    const first = say(f, 'Nogita, create a task for the release notes.', '1');
    await until(() => f.meeting.playing);
    f.meeting.interruptSpeech();
    f.meeting.speakMs = 10;
    await say(f, 'and another task for the changelog', '2');
    await first;
    await until(() => f.meeting.heard.includes('Both are on the board.'));
    assert.deepEqual(f.board.tasks.map(task => task.title), ['Release notes', 'Changelog'], repeatsA ? 'A repeated' : 'B only');
  }
});

test('the speaker\'s delivery choice holds for the combined answer: "say it aloud, don\'t send it in the chat"', async () => {
  const full = 'Four pull requests merged in the last three days, all on main. The first fixed the recap channel boundary. ' +
    'The second made the first speaker wait for the call to report who is there. The third added the meeting type in shadow mode.';
  const model = new Model(said => /tests/.test(said) ? [{ text: full }] : [{ text: LONG, delayMs: 300 }]);
  const meeting = new VoiceMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 60, talkingMs: 20, staleLeadInMs: 2_000 },
    listenFirst: true, speakWhenAsked: true, continueRequest: true });
  await engine.startSession('s', meeting);
  const first = engine.onUtterance('s', { text: "Nogita, explain what we merged, say it out loud, don't send it in the chat.", eventId: '1', actor: roee },
    { speakerKey: 'roee', turnEnded: true });
  await sleep(30);
  await engine.onUtterance('s', { text: 'and are the tests on main green?', eventId: '2', actor: roee }, { speakerKey: 'roee', turnEnded: true });
  await first;
  await until(() => meeting.heard.join(' ').includes('shadow mode'));
  assert.equal(meeting.heard[0], CONTINUE_ACK);
  assert.doesNotMatch(meeting.heard.join(' '), /in the chat/);
});

/**
 * The live path, as the server wires it: the audio hub's interim hook goes through continueOnInterim to the engine, and a
 * yes stops the hub's own playback. The speaker's audio is silent (echo cancellation), so the level gate never opens.
 */
type LiveOptions = { stt?: SttMode; stopOnInterim?: boolean };
/** One live hypothesis as each recognizer sends it: a Flux TurnInfo update or a Nova-3 interim result. */
const hypothesisMessage = (stt: SttMode, transcript: string) => stt === 'flux-english'
  ? { type: 'TurnInfo', event: 'Update', transcript }
  : { type: 'Results', is_final: false, speech_final: false, channel: { alternatives: [{ transcript }] } };

async function interimDuringAnswer(on: boolean, participant: string, hypothesis: string,
  { stt = 'flux-english', stopOnInterim = false }: LiveOptions = {}): Promise<string[]> {
  class Fake extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void {}
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const model = new Model(() => [{ text: LONG }]);
  const f = fixture(model, on);
  f.meeting.speakMs = 2_000;
  await f.engine.startSession('m', f.meeting);
  const listeners = new Map<string, Fake>();
  let tts!: Fake;
  const interrupts: string[] = [];
  let hub!: AttendeeRealtimeAudioHub;
  const onInterim = continueOnInterim(f.engine, () => hub);
  hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio', signingSecret: 's',
    deepgramApiKey: 'k', sttMode: stt, turnTakingV2: true, stopOnInterim, onTranscript: () => {}, onInterim,
    onInterrupt: (_s, event) => interrupts.push(event.cause),
    createWebSocket: url => {
      const socket = new Fake();
      if (url.includes('/speak')) tts = socket;
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      if (url.includes('/listen')) queueMicrotask(() => listeners.set(listeners.has('roee') ? 'dana' : 'roee', socket));
      return socket as unknown as WebSocket;
    } });
  hub.register('m');
  hub.bindBot('m', 'bot_m');
  const server = createServer();
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 's', 'm'));
  url.protocol = 'ws:';
  url.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(url);
  await once(client, 'open');
  const silence = Buffer.from(new Int16Array(1_600).buffer).toString('base64');
  try {
    for (const uuid of ['roee', 'dana']) {
      client.send(JSON.stringify({ bot_id: 'bot_m', trigger: 'realtime_audio.per_participant', data: { participant_uuid: uuid, sample_rate: 16000, chunk: silence } }));
      await until(() => listeners.has(uuid));
    }
    // Roee asked; the engine's answer is playing, and the hub is playing its audio.
    void f.engine.onUtterance('m', { text: 'Nogita, what merged this week?', eventId: '1', actor: roee }, { speakerKey: 'roee', turnEnded: true });
    await until(() => f.meeting.playing);
    void hub.speak('m', LONG).catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    tts.emit('message', Buffer.alloc(32_000, 1), true);
    await sleep(20);
    listeners.get(participant)!.emit('message', Buffer.from(JSON.stringify(hypothesisMessage(stt, hypothesis))), false);
    await sleep(20);
    return interrupts;
  } finally {
    f.meeting.interruptSpeech();
    await f.engine.endSession('m').catch(() => undefined);
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('live audio: the asker\'s first live words stop her playback; "okay", another speaker and the flag off do not', async () => {
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'and also which tests failed'), ['voice']);
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'okay'), [], 'a backchannel');
  assert.deepEqual(await interimDuringAnswer(true, 'dana', 'and also which tests failed'), [], 'another speaker');
  assert.deepEqual(await interimDuringAnswer(false, 'roee', 'and also which tests failed'), [], 'flag off');
});

// P10-1: the same path with Nova-3 (the multilingual default) and with NOGITA_STOP_ON_INTERIM on as well.
test('live audio, Nova-3: the asker\'s interim result stops her; "okay", "בסדר", another speaker and the flag off do not', async () => {
  const nova = { stt: 'nova3-multilingual' } as const;
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'and also which tests failed', nova), ['voice']);
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'וגם אילו טסטים נכשלו', nova), ['voice'], 'Hebrew continuation');
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'okay', nova), [], 'a backchannel');
  assert.deepEqual(await interimDuringAnswer(true, 'roee', 'בסדר', nova), [], 'a Hebrew backchannel');
  assert.deepEqual(await interimDuringAnswer(true, 'dana', 'and also which tests failed', nova), [], 'another speaker');
  assert.deepEqual(await interimDuringAnswer(false, 'roee', 'and also which tests failed', nova), [], 'flag off');
});

test('live audio with NOGITA_STOP_ON_INTERIM too: "stop" is one interruption, and a continuation still stops her once', async () => {
  for (const stt of ['flux-english', 'nova3-multilingual'] as const) {
    const both = { stt, stopOnInterim: true };
    assert.equal((await interimDuringAnswer(true, 'roee', 'okay stop', both)).length, 1, `${stt}: "stop" once`);
    assert.equal((await interimDuringAnswer(true, 'dana', 'okay stop', both)).length, 1, `${stt}: anyone's stop, as before`);
    assert.deepEqual(await interimDuringAnswer(true, 'roee', 'and also which tests failed', both), ['voice'], `${stt}: continuation`);
    assert.deepEqual(await interimDuringAnswer(true, 'dana', 'and also which tests failed', both), [], `${stt}: another speaker`);
    assert.deepEqual(await interimDuringAnswer(false, 'roee', 'okay stop', both), ['command'], `${stt}: flag off, stop-on-interim alone`);
  }
});
