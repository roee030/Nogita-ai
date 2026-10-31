import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine, addressesSomeoneElse, looksLikeCorrection, type QuestionEvent } from '../src/core/engine.ts';
import { SpeechFloor, unheard, type SpeakResult } from '../src/core/speech-floor.ts';
import { SpeechInterruptedError } from '../src/core/contracts.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const dana = { id: 'dana', displayName: 'Dana Levi', verified: true };
const guest = { id: 'unmapped:attendee:g1', displayName: 'Guest Person', verified: false };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await sleep(5);
  }
}

/** Replies by matching the request; records every model call. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly routes: Array<{ match: RegExp; text: string; delayMs?: number }>) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    if (request.stableSystem.startsWith('Name the topic')) return { content: [{ type: 'text', text: 'that' }], stopReason: 'end_turn' };
    const said = String(request.messages[0]?.content ?? '').split('says to you now:').at(-1) ?? '';
    const route = this.routes.find(candidate => candidate.match.test(said));
    if (route?.delayMs) await sleep(route.delayMs);
    const content: AgentContent[] = [];
    if (route?.text) { onText(route.text); content.push({ type: 'text', text: route.text }); }
    return { content, stopReason: 'end_turn' };
  }
  calls(): number { return this.requests.filter(request => !request.stableSystem.startsWith('Name the topic')).length; }
}

/** Playback that takes `pieceMs` and can be stopped part-way, like the realtime audio bridge. */
class PlaybackMeeting extends DemoMeeting {
  readonly spoken: string[] = [];
  readonly heard: string[] = [];
  private stop?: (played: number) => void;
  constructor(id: string, private readonly pieceMs = 80) { super(id); }
  override async speak(message: string): Promise<void> {
    this.spoken.push(message);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.stop = undefined; resolve(); }, this.pieceMs);
      this.stop = played => { clearTimeout(timer); this.stop = undefined; reject(new SpeechInterruptedError(played)); };
    });
    this.heard.push(message);
  }
  /** Playback stopped after `playedMs` of this piece. */
  cutOff(playedMs: number): boolean { if (!this.stop) return false; this.stop(playedMs); return true; }
  interruptSpeech(): boolean { return this.cutOff(0); }
  get playing(): boolean { return this.stop !== undefined; }
}

function fixture(model: ChatModel, pieceMs = 80) {
  const meeting = new PlaybackMeeting('m', pieceMs);
  const questions: QuestionEvent[] = [];
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, onQuestion: (_s, event) => questions.push(event),
    floor: { resumeAfterMs: 40, talkingMs: 40, staleLeadInMs: 2_000 } });
  const statuses = (id: number) => questions.filter(event => event.id === id).map(event => event.status);
  return { engine, meeting, questions, statuses };
}

test('words addressed to someone else by name, or to the group, are recognised', () => {
  const names = ['Dana', 'Avi'];
  for (const text of ['Dana, what do you think?', 'So Avi, can you take it?', 'Is that right, Dana?', 'Guys, are we done?', 'Okay everyone, next item.'])
    assert.equal(addressesSomeoneElse(text, names), true, text);
  for (const text of ['What did Dana say about the release?', 'And which one is older?', 'Can you show KAN-12?'])
    assert.equal(addressesSomeoneElse(text, names), false, text);
});

test('corrections are told apart from new questions', () => {
  for (const text of ['No, I meant the mobile app.', 'Actually, I mean staging.', "Sorry, I'm asking about the iOS build", 'No, the other one.'])
    assert.equal(looksLikeCorrection(text), true, text);
  for (const text of ['No.', 'Now show me KAN-4.', 'Nothing else, thanks.'])
    assert.equal(looksLikeCorrection(text), false, text);
});

test('group meeting: the follow-up window closes once someone else spoke', async () => {
  const model = new ScriptedModel([
    { match: /open tasks/, text: 'Two tasks are open.' },
    { match: /older/, text: 'KAN 11 is older.' },
    { match: /tomorrow/, text: '' },
  ]);
  const f = fixture(model, 5);
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Nogita, what are the open tasks?', eventId: '1', actor: roee });
  // Dana answers Roee; Roee's next unnamed question is to Dana, not to Nogita.
  await f.engine.onUtterance('s', { text: 'I can take one of them tomorrow.', eventId: '2', actor: dana });
  const calls = model.calls();
  assert.equal(await f.engine.onUtterance('s', { text: 'Which one is older?', eventId: '3', actor: roee }), 'ignored');
  assert.equal(model.calls(), calls);
  assert.deepEqual(f.meeting.spoken, ['Two tasks are open.']);
});

test('group meeting: within the window, words to another person by name and a "yeah" do not reach her', async () => {
  const model = new ScriptedModel([{ match: /open tasks/, text: 'Two tasks are open.' }, { match: /older/, text: 'KAN 11 is older.' }]);
  const f = fixture(model, 5);
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Hi all.', eventId: '0', actor: dana });
  await f.engine.onUtterance('s', { text: 'Nogita, what are the open tasks?', eventId: '1', actor: roee });
  const calls = model.calls();
  assert.equal(await f.engine.onUtterance('s', { text: 'Yeah.', eventId: '2', actor: roee }), 'ignored');
  assert.equal(model.calls(), calls);
  // A real follow-up from the same person still reaches her without her name.
  assert.equal(await f.engine.onUtterance('s', { text: 'And which one is older?', eventId: '3', actor: roee }), 'answered');
  // Turning to Dana by name is for Dana, even inside the window.
  const after = model.calls();
  assert.equal(await f.engine.onUtterance('s', { text: 'Dana, can you take the older one?', eventId: '4', actor: roee }), 'ignored');
  assert.equal(model.calls(), after);
  assert.deepEqual(f.meeting.spoken, ['Two tasks are open.', 'KAN 11 is older.']);
});

test('thanks closes the conversation quietly instead of starting another model turn', async () => {
  for (const thanks of ['Thank you.', 'Thanks, Nogita.', 'Nogita, thank you.', 'תודה.']) {
    const model = new ScriptedModel([{ match: /open tasks/, text: 'Two tasks are open.' }]);
    const f = fixture(model, 5);
    await f.engine.startSession('s', f.meeting);
    await f.engine.onUtterance('s', { text: 'Nogita, what are the open tasks?', eventId: '1', actor: roee });
    const calls = model.calls();
    assert.equal(await f.engine.onUtterance('s', { text: thanks, eventId: '2', actor: roee }), 'ignored', thanks);
    assert.equal(model.calls(), calls, thanks);
    assert.deepEqual(f.meeting.spoken, ['Two tasks are open.'], thanks);
  }
});

test('an unverified guest who spoke makes it a group: unnamed questions are not taken as hers', async () => {
  const model = new ScriptedModel([{ match: /deploy/, text: 'Tuesday.' }]);
  const f = fixture(model, 5);
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Hello, can you hear me?', eventId: '0', actor: guest });
  assert.equal(await f.engine.onUtterance('s', { text: 'When is the deploy?', eventId: '1', actor: roee }), 'ignored');
  assert.equal(model.calls(), 0);
});

test('"No, I meant ..." replaces the open question and stops what she was saying about the old one', async () => {
  const model = new ScriptedModel([
    { match: /corrected: "No, I meant the mobile app/, text: 'The mobile build is green.' },
    { match: /build status/, text: 'The web build failed on lint. The fix is in review.' },
  ]);
  const f = fixture(model, 200);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: "Nogita, what's the build status?", eventId: '1', actor: roee });
  await until(() => f.meeting.playing);
  assert.equal(await f.engine.onUtterance('s', { text: 'No, I meant the mobile app.', eventId: '2', actor: roee }), 'answered');
  await first;
  // The old answer was stopped mid-piece and never resumed.
  assert.deepEqual(f.meeting.heard, ['The mobile build is green.']);
  assert.ok(!f.meeting.spoken.slice(1).some(text => /web build/.test(text)), f.meeting.spoken.join(' | '));
  assert.equal(f.statuses(1).at(-1), 'superseded');
  assert.equal(f.statuses(2).at(-1), 'answered');
});

test('"stop" stops the piece playing now even when her voice detector missed it, and nothing stale plays after', async () => {
  const model = new ScriptedModel([{ match: /architecture/, text: 'First the bot joins. Then it listens. Then it answers.' }]);
  const f = fixture(model, 200);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, explain the architecture.', eventId: '1', actor: roee });
  await until(() => f.meeting.playing);
  assert.equal(await f.engine.onUtterance('s', { text: 'Nogita, stop.', eventId: '2', actor: dana }), 'answered');
  assert.equal(f.meeting.playing, false);
  await first;
  await sleep(150);
  assert.deepEqual(f.meeting.heard, []);
  assert.equal(f.meeting.spoken.length, 1);
  assert.equal(f.statuses(1).at(-1), 'stopped');
});

test('"stop" followed by a new request stops the old answer and answers the remainder', async () => {
  const model = new ScriptedModel([
    { match: /main file/, text: 'The main file is server.ts.' },
    { match: /meeting works/, text: 'First the bot joins. Then it listens. Then it answers.' },
  ]);
  const f = fixture(model, 200);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', {
    text: 'Nogita, walk me through how a meeting works.', eventId: '1', actor: roee,
  });
  await until(() => f.meeting.playing);
  assert.equal(await f.engine.onUtterance('s', {
    text: 'Nogita, stop. Just tell me the name of the main file.', eventId: '2', actor: roee,
  }), 'answered');
  await first;
  assert.deepEqual(f.meeting.heard, ['The main file is server.ts.']);
  assert.equal(f.statuses(1).at(-1), 'stopped');
  assert.equal(f.statuses(2).at(-1), 'answered');
});

test('"never mind" while the answer plays stops it; only the acknowledgement follows', async () => {
  const model = new ScriptedModel([{ match: /sprint/, text: 'There are four tasks left in the sprint and two are blocked.' }]);
  const f = fixture(model, 200);
  await f.engine.startSession('s', f.meeting);
  const first = f.engine.onUtterance('s', { text: 'Nogita, how is the sprint going?', eventId: '1', actor: roee });
  await until(() => f.meeting.playing);
  assert.equal(await f.engine.onUtterance('s', { text: 'Never mind.', eventId: '2', actor: roee }), 'answered');
  await first;
  await until(() => !f.meeting.playing && f.meeting.heard.length === 1, 3_000);
  assert.deepEqual(f.meeting.heard, ['Okay.']); // she was already answering: nothing left to "drop"
  assert.equal(f.statuses(1).at(-1), 'cancelled');
});

test('a cut-off answer resumes from the first sentence that was not heard', async () => {
  assert.equal(unheard('One two. Three four. Five six.', undefined, 14), 'One two. Three four. Five six.');
  assert.equal(unheard('One two. Three four. Five six.', 700, 14), 'Three four. Five six.');
  assert.equal(unheard('One two. Three four. Five six.', 5_000, 14), '');
  const said: string[] = [];
  let calls = 0;
  const floor = new SpeechFloor({ schedule: (work, ms) => setTimeout(work, ms), cancel: handle => clearTimeout(handle as never),
    resumeAfterMs: 5, speak: async (text): Promise<SpeakResult> => {
      said.push(text);
      // The first sentence (24 characters) played fully, then a participant cut in.
      return ++calls === 1 ? { outcome: 'interrupted', heardMs: 2_000 } : 'spoken';
    } });
  assert.equal(await floor.say(1, 'The cache keeps entries. They expire after five minutes.'), 'spoken');
  assert.deepEqual(said, ['The cache keeps entries. They expire after five minutes.', 'They expire after five minutes.']);
});

test('a cut-off answer stays paused through a mid-turn silence until the speaker turn ends', async () => {
  let now = 0;
  const timers: Array<{ at: number; work: () => void; cancelled: boolean }> = [];
  const schedule = (work: () => void, delayMs: number) => {
    const timer = { at: now + delayMs, work, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const timer = timers.filter(candidate => !candidate.cancelled && candidate.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      timer.cancelled = true;
      timer.work();
      await Promise.resolve();
    }
  };
  const said: string[] = [];
  let interrupt!: (result: SpeakResult) => void;
  const floor = new SpeechFloor({ now: () => now, schedule,
    cancel: handle => { (handle as { cancelled: boolean }).cancelled = true; }, resumeAfterMs: 0,
    speak: async text => {
      said.push(text);
      if (said.length > 1) return 'spoken';
      return new Promise<SpeakResult>(resolve => { interrupt = resolve; });
    } });

  const answer = floor.say(1, 'The first answer is still in progress.');
  await Promise.resolve();
  floor.noteTalking('roee');
  interrupt({ outcome: 'interrupted', heardMs: 0 });
  await Promise.resolve();
  await Promise.resolve();

  // Flux can have more than a second of quiet inside one compound utterance ("stop ... just tell me").
  await advance(1_200);
  assert.deepEqual(said, ['The first answer is still in progress.']);

  floor.noteTalking('roee', true);
  assert.equal(await answer, 'spoken');
  assert.equal(said.length, 2);
});

test('a cut that came after everything was heard is not repeated', async () => {
  const said: string[] = [];
  const floor = new SpeechFloor({ resumeAfterMs: 5, speak: async (text): Promise<SpeakResult> => {
    said.push(text);
    return said.length === 1 ? { outcome: 'interrupted', heardMs: 10_000 } : 'spoken';
  } });
  assert.equal(await floor.say(1, 'It is green.'), 'spoken');
  assert.deepEqual(said, ['It is green.']);
});

test('a question whose run throws still ends in a final status (no stuck "thinking" screen)', async () => {
  const model: ChatModel = { agentModel: 'broken', streamChat: async () => { throw new Error('boom'); } };
  const f = fixture(model, 5);
  // The planner fallback also fails, so the run throws after the question opened.
  (f.engine as unknown as { dependencies: { brain: { plan: () => Promise<never> } } }).dependencies.brain.plan = async () => { throw new Error('planner down'); };
  await f.engine.startSession('s', f.meeting);
  await assert.rejects(f.engine.onUtterance('s', { text: 'Nogita, what is open?', eventId: '1', actor: roee }));
  const last = f.statuses(1).at(-1);
  assert.ok(last && !['working', 'answering', 'interrupted', 'speculative'].includes(last), String(last));
});
