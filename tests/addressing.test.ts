import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy, asksTheRoom, looksLikeCrosstalk } from '../src/core/policy.ts';
import { roomNoiseGuard } from '../src/app/config.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

// Heard in the voice lab (P3-11 live run, `meeting-room` and `room-crosstalk`, office noise on one shared mic).
const mixed = [
  'first perspective, and I think the client wants to do the wrong demo. -- across three -- -- on the first floor is supposed to -- Wait. Is that the really big file? Yeah. The huge one. I opened it last week. I think the client',
  'Does anyone try for my one stop conversion after all? Did anyone go up the road for Thursday afternoon?... TTP status five hundred three mean?',
  'Oh, wait. I think I looked at myself. And which bottle starts sooner? -- one percent',
  'on the first floor is supposed to be -- Okay. Moving on to the design review.',
  'the coffee machine on the third floor is broken again and',
];
const clean = [
  'Nogita, which file has the main meeting engine?',
  'Wait, is that the really big file?',
  'And which one is older?',
  "what's in progress on the board?",
  'I think the retry is in the worker.',
  'Okay. Moving on to the design review.',
  'The token expires hourly',
];

test('a transcript of mixed voices or chatter caught mid-sentence is recognized', () => {
  for (const text of mixed) assert.equal(looksLikeCrosstalk(text), true, text);
  for (const text of clean) assert.equal(looksLikeCrosstalk(text), false, text);
});

test('a question for the whole room is not a question for her', () => {
  for (const text of ['Did anyone book the room for Thursday afternoon?', 'Has anybody seen the charger?', 'Anyone up for lunch?',
    'So, does everyone have the slides?', 'Okay. Did anyone see where I left the charger?']) assert.equal(asksTheRoom(text), true, text);
  for (const text of ['What did anyone change in the engine today?', 'Which file starts the server?', 'Is the build green?', 'Someone broke the build yesterday.'])
    assert.equal(asksTheRoom(text), false, text);
});

test('NOGITA_ROOM_NOISE_GUARD is off unless set to true', () => {
  assert.equal(roomNoiseGuard({}), false);
  assert.equal(roomNoiseGuard({ NOGITA_ROOM_NOISE_GUARD: '' }), false);
  assert.equal(roomNoiseGuard({ NOGITA_ROOM_NOISE_GUARD: 'false' }), false);
  assert.equal(roomNoiseGuard({ NOGITA_ROOM_NOISE_GUARD: 'true' }), true);
  assert.throws(() => roomNoiseGuard({ NOGITA_ROOM_NOISE_GUARD: 'yes' }), /must be true or false/);
});

/** Answers by matching the request; records every model call. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly asked: string[] = [];
  constructor(private readonly answers: Array<[RegExp, string]>) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.stableSystem.startsWith('Name the topic')) return { content: [{ type: 'text', text: 'that' }], stopReason: 'end_turn' };
    const said = String(request.messages[0]?.content ?? '').split('says to you now:').at(-1) ?? '';
    this.asked.push(said);
    const text = this.answers.find(([match]) => match.test(said))?.[1] ?? '';
    if (text) onText(text);
    return { content: text ? [{ type: 'text', text }] : [], stopReason: 'end_turn' };
  }
}

class VoiceMeeting extends DemoMeeting {
  readonly spoken: string[] = [];
  override async speak(message: string): Promise<void> {
    this.spoken.push(message);
    this.events.push({ type: 'speak', text: message });
  }
}

// Dana and Avi talk into Roee's laptop: the meeting hears all of them as Roee. Noa is remote.
const roee = { id: 'roee', displayName: 'Roee', verified: true };
const noa = { id: 'noa', displayName: 'Noa', verified: true };

async function room(guard: boolean, answers: Array<[RegExp, string]>) {
  const model = new ScriptedModel(answers);
  const meeting = new VoiceMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'noa'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, roomNoiseGuard: guard });
  await engine.startSession('s', meeting);
  let n = 0;
  const say = (text: string, actor = roee) => engine.onUtterance('s', { text, eventId: String(++n), actor });
  return { model, meeting, say };
}

const ENGINE: [RegExp, string] = [/main meeting engine/, 'The main engine is engine.ts.'];

test('room noise guard: side talk on the shared mic after her answer gets no reply (meeting-room)', async () => {
  const r = await room(true, [ENGINE, [/./, 'Roee, the big one is engine.ts. The rest of what you said cut out.']]);
  await r.say('Nogita, which file has the main meeting engine?');
  await r.say(mixed[0]!);
  await r.say('Yeah, the huge one. I opened it last week.');
  await r.say('Honestly I need more coffee before the next meeting.');
  assert.deepEqual(r.meeting.spoken, ['The main engine is engine.ts.']);
  assert.equal(r.model.asked.length, 1);
});

test('without the guard the same side talk still reaches the model as a follow-up (rollback profile)', async () => {
  const r = await room(false, [ENGINE, [/./, '']]);
  await r.say('Nogita, which file has the main meeting engine?');
  await r.say(mixed[0]!);
  assert.equal(r.model.asked.length, 2);
});

test('room noise guard: a question for the room and mixed chatter on one mic are not for her (room-crosstalk)', async () => {
  const r = await room(true, [[/503/, 'Service unavailable: the server is overloaded or down.'], [/./, 'Not sure.']]);
  // Only Roee's mic has been heard, so an unnamed question would count as one-to-one.
  await r.say('Did anyone book the room for Thursday afternoon?');
  await r.say('Nogita, what does HTTP status 503 mean?');
  await r.say(mixed[2]!);
  await r.say('on the first floor is supposed to be -- Okay. Moving on to the design review.');
  assert.deepEqual(r.meeting.spoken, ['Service unavailable: the server is overloaded or down.']);
  assert.equal(r.model.asked.length, 1);
});

test('room noise guard: a real follow-up and a named question in a busy room are still answered', async () => {
  const r = await room(true, [ENGINE, [/how big is it/, 'About 1,500 lines.'], [/language/, 'TypeScript, on Node.']]);
  await r.say('Nogita, which file has the main meeting engine?');
  await r.say('And how big is it?');
  await r.say('Nogita, what language is this project written in?', noa);
  assert.deepEqual(r.meeting.spoken, ['The main engine is engine.ts.', 'About 1,500 lines.', 'TypeScript, on Node.']);
});

test('room noise guard: a follow-up reply never asks the room to repeat; a named question may', async () => {
  const r = await room(true, [ENGINE, [/which test/, "Sounds like that got cut off. It's engine.test.ts."],
    [/what was that/, "Sorry, that cut out. Could you repeat it?"]]);
  await r.say('Nogita, which file has the main meeting engine?');
  await r.say('And which test covers it?');
  assert.equal(r.meeting.spoken.at(-1), "It's engine.test.ts.");
  await r.say('Nogita, what was that?');
  assert.deepEqual(r.meeting.spoken.slice(-2), ['Sorry, that cut out.', 'Could you repeat it?']);
});
