import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import { parseAttendeeTranscript, roomActorId } from '../src/app/attendee-webhook.ts';
import { roomAware } from '../src/app/config.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

class Scripted implements ChatModel {
  readonly agentModel = 'scripted';
  calls = 0;
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.calls++;
    onText('Sixteen PRs landed today.');
    return { content: [{ type: 'text', text: 'Sixteen PRs landed today.' }] as AgentContent[], stopReason: 'end_turn' };
  }
}
class Recording extends DemoMeeting {
  readonly spoken: string[] = [];
  override async speak(message: string): Promise<void> { this.spoken.push(message); await super.speak(message); }
}
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const dana = { id: 'dana', displayName: 'Dana Levi', verified: false };

async function meeting(options: { listenFirst?: boolean; roomAware?: boolean; restored?: boolean } = {}) {
  const model = new Scripted();
  const m = new Recording('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model, people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 },
    listenFirst: options.listenFirst ?? true, roomAware: options.roomAware ?? true });
  if (options.restored) engine.restoreSession('s', m);
  else await engine.startSession('s', m);
  let n = 0;
  const say = (text: string, actor = roee) => engine.onUtterance('s', { text, eventId: String(++n), actor });
  const silent = () => {
    assert.equal(model.calls, 0, 'no model call');
    assert.deepEqual(m.spoken, [], 'nothing spoken');
  };
  return { model, m, say, engine, silent };
}

test('group meeting: the first speaker talking to a colleague gets silence, and naming her gets an answer', async () => {
  const f = await meeting();
  f.engine.noteRoom('s', ['roee', 'dana']);
  assert.equal(await f.say('Dana, what landed in main today?'), 'ignored');
  assert.equal(await f.say('What landed in main today?'), 'ignored');
  f.silent();
  await f.say('Nogita, what landed in main today?');
  assert.equal(f.model.calls, 1);
  assert.equal(f.m.spoken.length, 1);
});

test('without the flag the old behavior stays: the first speaker counts as alone', async () => {
  const f = await meeting({ roomAware: false });
  f.engine.noteRoom('s', ['roee', 'dana']);
  await f.say('What landed in main today?');
  assert.equal(f.model.calls, 1);
});

test('the flag is off unless set to true', () => {
  assert.equal(roomAware({}), false);
  assert.equal(roomAware({ NOGITA_ROOM_AWARE: 'false' }), false);
  assert.equal(roomAware({ NOGITA_ROOM_AWARE: 'true' }), true);
  assert.throws(() => roomAware({ NOGITA_ROOM_AWARE: 'yes' }), /NOGITA_ROOM_AWARE/);
});

test('nobody reported yet: she does not assume she is alone', async () => {
  const f = await meeting();
  assert.equal(await f.say('What landed in main today?'), 'ignored');
  f.silent();
});

test('really alone with her: an unnamed request and the next words get an answer', async () => {
  const f = await meeting();
  f.engine.noteRoom('s', ['roee']);
  await f.say('What landed in main today?');
  assert.equal(f.model.calls, 1);
  await f.say('And which ones are mine?');
  assert.equal(f.model.calls, 2);
});

test('the only person reported is somebody else: the speaker is not alone with her', async () => {
  const f = await meeting();
  f.engine.noteRoom('s', ['dana']);
  assert.equal(await f.say('What landed in main today?'), 'ignored');
  f.silent();
});

test('a silent colleague leaving leaves the speaker alone; a colleague who spoke ends "alone" for the meeting', async () => {
  const quiet = await meeting();
  quiet.engine.noteRoom('s', ['roee', 'dana']);
  quiet.engine.noteRoom('s', ['roee']);
  await quiet.say('What landed in main today?');
  assert.equal(quiet.model.calls, 1);

  const spoke = await meeting();
  spoke.engine.noteRoom('s', ['roee', 'dana']);
  await spoke.say('Morning everyone.', dana);
  spoke.engine.noteRoom('s', ['roee']);
  assert.equal(await spoke.say('What landed in main today?'), 'ignored');
  spoke.silent();
});

test('after a restart the room is unknown for the rest of the meeting, whoever joins later', async () => {
  const f = await meeting({ restored: true });
  f.engine.noteRoom('s', ['roee']);
  assert.equal(await f.say('What landed in main today?'), 'ignored');
  f.silent();
  await f.say('Nogita, what landed in main today?');
  assert.equal(f.model.calls, 1);
});

test('legacy turn-taking gets the same answer about who is alone', async () => {
  const f = await meeting({ listenFirst: false });
  f.engine.noteRoom('s', ['roee', 'dana']);
  await f.say('Dana, what landed in main today?');
  assert.equal(f.model.calls, 0);
  assert.deepEqual(f.m.spoken, []);
});

test('a participant and the same person speaking get one id, mapped or not', () => {
  const identities = new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel', attendeeUserUuid: 'user-roee' }]);
  const spoken = (userUuid: string | undefined, speaker: string) => parseAttendeeTranscript({ idempotency_key: 'e', bot_id: 'b', bot_metadata: { session_id: 's' },
    trigger: 'transcript.update', data: { speaker_uuid: speaker, ...(userUuid ? { speaker_user_uuid: userUuid } : {}), speaker_name: 'Someone', transcription: { transcript: 'hello' } } }, identities)!.utterance.actor.id;
  assert.equal(roomActorId('p1', 'user-roee', identities), 'roee');
  assert.equal(roomActorId('p1', 'user-roee', identities), spoken('user-roee', 'p1'));
  assert.equal(roomActorId('p2', 'user-dana', identities), spoken('user-dana', 'p2'));
  assert.equal(roomActorId('p3', undefined, identities), spoken(undefined, 'p3'));
});
