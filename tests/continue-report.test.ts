// P10-3: each time NOGITA_CONTINUE_REQUEST stops her, the turn log gets how long it took from the asker's first live
// words to the stop, and what came of it (continued, corrected, stopped, cancelled, or nothing: a false interruption).
// No words, no names: the rows are counts, times and meeting-scoped hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine, type ContinueEvent } from '../src/core/engine.ts';
import { SpeechInterruptedError } from '../src/core/contracts.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { continueOnInterim } from '../src/app/continue-barge-in.ts';
import { analyse, render } from '../tools/turn-report.ts';

const roee = { id: 'roee', displayName: 'Roee', verified: true };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await sleep(5);
  }
}

const LONG = 'Four pull requests merged in the last three days. Nine commits, all on main.';
class Model implements ChatModel {
  readonly agentModel = 'scripted';
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.stableSystem.startsWith('Name the topic')) return { content: [{ type: 'text', text: 'that' }], stopReason: 'end_turn' };
    onText(LONG);
    return { content: [{ type: 'text', text: LONG }], stopReason: 'end_turn' };
  }
}
class VoiceMeeting extends DemoMeeting {
  speakMs = 2_000;
  private stopNow?: () => void;
  get playing(): boolean { return this.stopNow !== undefined; }
  override async speak(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.stopNow = undefined; resolve(); }, this.speakMs);
      this.stopNow = () => { clearTimeout(timer); this.stopNow = undefined; reject(new SpeechInterruptedError()); };
    });
  }
  interruptSpeech(): boolean {
    if (!this.stopNow) return false;
    this.stopNow();
    return true;
  }
}

async function fixture(on = true) {
  const meeting = new VoiceMeeting('m');
  const events: ContinueEvent[] = [];
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: new Model() },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 60, talkingMs: 20, staleLeadInMs: 2_000 },
    continueRequest: on, onContinue: (_s, event) => events.push(event) });
  await engine.startSession('s', meeting);
  // As the server wires it: the audio hub's interim hook, here stopping the test meeting's playback.
  const interim = continueOnInterim(engine, () => ({ interruptSpeech: () => meeting.interruptSpeech() }));
  return { engine, meeting, events, interim };
}
const say = (f: Awaited<ReturnType<typeof fixture>>, text: string, eventId: string) =>
  f.engine.onUtterance('s', { text, eventId, actor: roee }, { speakerKey: 'roee', turnEnded: true });

/** Roee asks; while the answer plays, his live words arrive (first "and", then more), then his finished turn. */
async function interruptWith(final: string, on = true) {
  const f = await fixture(on);
  const first = say(f, 'Nogita, what merged this week?', '1');
  await until(() => f.meeting.playing);
  f.interim('s', 'roee', 'and');
  await sleep(40);
  const stopped = f.interim('s', 'roee', 'and also');
  await say(f, final, '2');
  f.meeting.interruptSpeech();
  // After a false interruption the answer waits to resume, on a timer this fixture never runs: the meeting ends it.
  await Promise.race([first.catch(() => undefined), sleep(100)]);
  return { ...f, stopped };
}

test('a continuation: one yield row with the time from his first live word, then outcome "continued"', async () => {
  const f = await interruptWith('and also which tests failed');
  assert.equal(f.stopped, true);
  const [yielded, outcome] = f.events;
  assert.equal(f.events.length, 2, JSON.stringify(f.events));
  assert.equal(yielded!.phase, 'yield');
  assert.ok(yielded!.phase === 'yield' && yielded!.silenceMs >= 30, `from "and" to the stop: ${JSON.stringify(yielded)}`);
  assert.deepEqual(outcome && { phase: outcome.phase, outcome: outcome.phase === 'outcome' && outcome.outcome }, { phase: 'outcome', outcome: 'continued' });
  await f.engine.endSession('s');
});

test('the outcome is "corrected", "stopped" or "cancelled" by what he said, in English or Hebrew', async () => {
  for (const [final, expected] of [['no, I meant the mobile app', 'corrected'], ['לא, התכוונתי למובייל', 'corrected'],
    ['stop', 'stopped'], ['עצרי', 'stopped'], ['never mind', 'cancelled'], ['בטלי', 'cancelled']] as const) {
    const f = await interruptWith(final);
    const outcome = f.events.find(event => event.phase === 'outcome');
    assert.equal(outcome?.phase === 'outcome' && outcome.outcome, expected, final);
    await f.engine.endSession('s');
  }
});

test('a false interruption: his finished turn adds nothing ("okay"), or the meeting ends first, and the outcome is "none"', async () => {
  const f = await interruptWith('okay');
  assert.equal(f.events.find(event => event.phase === 'outcome')?.phase === 'outcome' &&
    (f.events.find(event => event.phase === 'outcome') as Extract<ContinueEvent, { phase: 'outcome' }>).outcome, 'none');
  await f.engine.endSession('s');

  const g = await fixture();
  void say(g, 'Nogita, what merged this week?', '1');
  await until(() => g.meeting.playing);
  assert.equal(g.interim('s', 'roee', 'and also'), true);
  await g.engine.endSession('s');
  assert.deepEqual(g.events.map(event => event.phase === 'outcome' ? event.outcome : event.phase), ['yield', 'none']);
});

test('flag off: no rows; and no row ever holds words or names', async () => {
  const off = await interruptWith('and also which tests failed', false);
  assert.equal(off.stopped, false);
  assert.deepEqual(off.events, []);
  await off.engine.endSession('s');

  const on = await interruptWith('and also which tests failed');
  const rows = JSON.stringify(on.events);
  for (const words of ['also', 'tests', 'merged', 'Roee']) assert.ok(!rows.includes(words), `"${words}" in ${rows}`);
  for (const event of on.events) {
    assert.deepEqual(Object.keys(event).sort(), event.phase === 'yield' ? ['id', 'phase', 'silenceMs', 'speakerKey'] : ['id', 'ms', 'outcome', 'phase', 'speakerKey']);
  }
  await on.engine.endSession('s');
});

test('the report counts stops, the time to silence (p50, p90) and false interruptions, with no pass mark', () => {
  const rows = [
    { at: 0, type: 'session', phase: 'start' },
    ...[120, 200, 340, 90].flatMap((silenceMs, n) => [
      { at: 1_000 * n, type: 'continue', phase: 'yield', id: n, speaker: `m_${n}`, silenceMs },
      { at: 1_000 * n + 500, type: 'continue', phase: 'outcome', id: n, speaker: `m_${n}`,
        outcome: ['continued', 'corrected', 'none', 'stopped'][n], ms: 500 },
    ]),
    { at: 10_000, type: 'session', phase: 'end' },
  ];
  const report = analyse('meet-1', rows);
  assert.deepEqual(report.continueStops, { silenceMs: [120, 200, 340, 90],
    outcomes: { continued: 1, corrected: 1, none: 1, stopped: 1 } });
  const text = render([report]);
  assert.match(text, /## Continue-request stops \(NOGITA_CONTINUE_REQUEST, P10-3\)/);
  assert.match(text, /\| meet-1 \| 4 \| 0\.12 s \/ 0\.34 s \| 1 \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(text, /no pass mark/i);
});
