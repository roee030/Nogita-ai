import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceHub, levelFromRms, pcmLevels, type PresenceSnapshot } from '../src/app/presence.ts';
import { SpeechFloor } from '../src/core/speech-floor.ts';
import { isExplicitLeaveRequest } from '../src/core/policy.ts';

function rig() {
  let now = 1_000;
  const timers: Array<{ at: number; work: () => void; id: number }> = [];
  let nextId = 0;
  const hub = new PresenceHub({ now: () => now, boardName: 'Jira', chatName: 'Slack',
    schedule: (work, delayMs) => { const id = nextId++; timers.push({ at: now + delayMs, work, id }); return id; },
    cancel: handle => { const i = timers.findIndex(timer => timer.id === handle); if (i >= 0) timers.splice(i, 1); } });
  const key = hub.open('s');
  const states: PresenceSnapshot[] = [];
  const events: Array<[string, unknown]> = [];
  hub.subscribe('s', (event, data) => { events.push([event, data]); if (event === 'state') states.push(data as PresenceSnapshot); });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.work();
    }
  };
  return { hub, key, states, events, advance, last: () => states.at(-1)! };
}

const tone = (ms: number, amplitude: number) => {
  const pcm = Buffer.alloc(16 * ms * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * amplitude * 32767), i * 2);
  return pcm;
};

test('presence starts ready and only the meeting key opens its stream', () => {
  const { hub, key, last } = rig();
  assert.equal(last().state, 'idle');
  assert.equal(hub.authorized('s', key), true);
  assert.equal(hub.authorized('s', 'wrong'), false);
  assert.equal(hub.authorized('other', key), false);
});

test('a named speaker is listened to; a confirmed question becomes thinking with what she heard and her real tool', () => {
  const { hub, last, advance } = rig();
  hub.addressed('s', 'p1');
  assert.equal(last().state, 'listening');
  // Their voice keeps it alive; someone else's does not.
  advance(2_500); hub.voice('s', 'p1'); advance(2_500);
  assert.equal(last().state, 'listening');
  hub.question('s', { id: 1, status: 'speculative', request: 'why does login time out' });
  assert.equal(last().state, 'listening');
  hub.question('s', { id: 1, status: 'working', request: 'why does login time out' });
  assert.deepEqual(last(), { state: 'thinking', status: 'Got it', about: 'why does login time out', open: 1, phase: 'understanding' });
  advance(1_600);
  assert.equal(last().status, 'Working on your question');
  hub.tool('s', 1, ['search_tasks']);
  assert.equal(last().status, 'Checking Jira');
  assert.equal(last().phase, 'investigating');
  hub.tool('s', 1, ['create_task']);
  assert.equal(last().phase, 'executing');
  hub.waiting('s', true);
  assert.equal(last().status, 'Ready to answer · waiting for a pause');
});

test('listening ends by itself when nothing follows the name', () => {
  const { hub, last, advance } = rig();
  hub.addressed('s', 'p1');
  hub.voice('s', 'p2');
  advance(3_100);
  assert.equal(last().state, 'idle');
});

test('speaking follows her real audio and returns to the open question or ready', () => {
  const { hub, last, events, advance } = rig();
  hub.question('s', { id: 1, status: 'working', request: 'what changed', topic: 'recent changes' });
  hub.question('s', { id: 1, status: 'answering', request: 'what changed' });
  hub.outputAudio('s', tone(400, 0.3));
  assert.deepEqual(last(), { state: 'speaking', status: 'Answering', about: 'recent changes', open: 1 });
  const out = events.find(([event]) => event === 'out')![1] as { f: number; l: number[] };
  assert.equal(out.f, 40);
  assert.equal(out.l.length, 10);
  assert.ok(out.l.every(level => level > 0.5));
  advance(800);
  assert.equal(last().state, 'thinking');
  hub.question('s', { id: 1, status: 'answered', request: 'what changed' });
  assert.equal(last().state, 'idle');
});

test('a rolled-back early start never shows thinking; a failed answer shows a problem that clears', () => {
  const { hub, states, last, advance } = rig();
  hub.question('s', { id: 1, status: 'speculative', request: 'what is' });
  hub.question('s', { id: 1, status: 'rolled_back', request: 'what is' });
  assert.ok(!states.some(state => state.state === 'thinking'));
  hub.question('s', { id: 2, status: 'working', request: 'deploy status' });
  hub.question('s', { id: 2, status: 'failed', request: 'deploy status' });
  assert.deepEqual(last(), { state: 'error', status: 'Having trouble responding', open: 0, tone: 'warning' });
  advance(6_100);
  assert.equal(last().state, 'idle');
});

test('several open questions are counted; closing shows leaving and ends the stream', () => {
  const { hub, last, events, advance } = rig();
  hub.question('s', { id: 1, status: 'working', request: 'one' });
  hub.question('s', { id: 2, status: 'working', request: 'two' });
  assert.equal(last().open, 2);
  hub.close('s');
  assert.equal(last().state, 'leaving');
  advance(1_600);
  assert.equal(events.at(-1)![0], 'end');
  assert.equal(hub.has('s'), false);
});

test('levels map speech loudness to 0..1', () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(10 ** (-50 / 20)), 0);
  assert.equal(levelFromRms(10 ** (-10 / 20)), 1);
  assert.deepEqual(pcmLevels(Buffer.alloc(16 * 100 * 2)), [0, 0, 0]);
});

test('the floor reports an answer waiting for an opening, but not a lead-in', async () => {
  let now = 0;
  const waiting: boolean[] = [];
  const floor = new SpeechFloor({ now: () => now, speak: async () => 'spoken', onWaiting: value => waiting.push(value),
    schedule: () => 1, cancel: () => undefined });
  floor.noteTalking('p1');
  void floor.say(1, 'Checking.', { leadIn: true });
  assert.deepEqual(waiting, []);
  void floor.say(1, 'It is open.');
  assert.deepEqual(waiting, [true]);
  now = 2_000;
  floor.noteTalking('p1', true);
  assert.deepEqual(waiting, [true, false]);
  floor.close();
});

test('leave requests as people say them (and as recognition hears them)', () => {
  for (const text of ['you can drop.', 'Okay, you can drop.', 'drop from this meeting now.', 'dropped from this meeting, please.',
    'leave the meeting', 'can you leave?', 'end the call', 'get off the call']) {
    assert.equal(isExplicitLeaveRequest(text), true, text);
  }
  for (const text of ['drop it', 'end', 'leave the meeting?', 'what do you think about the drop?', 'drop the second bug']) {
    assert.equal(isExplicitLeaveRequest(text), false, text);
  }
});

test('the Attendee bot shares the presence page as a screen share, or as its camera', async () => {
  const { AttendeeMeeting } = await import('../src/adapters/attendee.ts');
  for (const mode of ['screenshare', 'camera'] as const) {
    let body: Record<string, unknown> = {};
    const http = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot_abc' }), { status: 201 });
    }) as unknown as typeof fetch;
    const meeting = new AttendeeMeeting('s', 'key', true, http, undefined, undefined, undefined, undefined, undefined, undefined,
      { url: 'https://nogita.example/presence/s?k=abc', mode });
    await meeting.join('https://meet.google.com/abc-defg-hij');
    assert.deepEqual(body.voice_agent_settings, mode === 'camera'
      ? { url: 'https://nogita.example/presence/s?k=abc' } : { screenshare_url: 'https://nogita.example/presence/s?k=abc' });
  }
});

test('speaking ends when her audio has played, however many chunks it came in', () => {
  const { hub, last, advance } = rig();
  // 100 chunks of 40 ms sent at playback pace: 4 s of speech.
  for (let i = 0; i < 100; i++) { hub.outputAudio('s', tone(40, 0.2)); advance(40); }
  assert.equal(last().state, 'speaking');
  advance(400);
  assert.equal(last().state, 'idle');
});

test('a card she was asked to show reaches the page, new subscribers too, and can be cleared', () => {
  const { hub, events } = rig();
  hub.show('s', { kind: 'task', key: 'KAN-20', title: 'Privacy approval', url: 'https://jira.example/KAN-20' });
  assert.deepEqual(events.at(-1), ['card', { card: { kind: 'task', key: 'KAN-20', title: 'Privacy approval', url: 'https://jira.example/KAN-20' } }]);
  const late: Array<[string, unknown]> = [];
  hub.subscribe('s', (event, data) => late.push([event, data]));
  assert.equal(late[1]![0], 'card');
  hub.show('s', undefined);
  assert.deepEqual(events.at(-1), ['card', { card: null }]);
});
