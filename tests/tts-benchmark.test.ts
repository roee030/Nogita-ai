import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { renderBlindRatingCsv, runTtsBenchmark, summarizeTtsBenchmark, type TtsBenchmarkProvider, type TtsBenchmarkSample } from '../tools/voice-lab/tts-benchmark.ts';
import { cartesiaTtsBenchmarkProvider, deepgramTtsBenchmarkProvider } from '../tools/voice-lab/tts-providers.ts';

test('TTS benchmark reports cold and warm latency separately and keeps failures visible', () => {
  const samples: TtsBenchmarkSample[] = [
    { provider: 'deepgram', model: 'aura', voice: 'thalia', phase: 'cold', textId: 'a', connectMs: 100,
      ttfaMs: 300, totalMs: 900, audioBytes: 32_000 },
    { provider: 'deepgram', model: 'aura', voice: 'thalia', phase: 'warm', textId: 'b', connectMs: 0,
      ttfaMs: 30, totalMs: 600, audioBytes: 24_000 },
    { provider: 'cartesia', model: 'sonic', voice: 'skylar', phase: 'cold', textId: 'a', connectMs: 80,
      ttfaMs: 180, totalMs: 700, audioBytes: 30_000 },
    { provider: 'cartesia', model: 'sonic', voice: 'skylar', phase: 'warm', textId: 'b', connectMs: 0,
      error: 'rate limited' },
  ];

  assert.deepEqual(summarizeTtsBenchmark(samples), [
    { provider: 'cartesia', model: 'sonic', voice: 'skylar', phase: 'cold', attempts: 1, successes: 1, failures: 0,
      ttfa: { count: 1, mean: 180, p50: 180, p90: 180, min: 180, max: 180 },
      total: { count: 1, mean: 700, p50: 700, p90: 700, min: 700, max: 700 } },
    { provider: 'cartesia', model: 'sonic', voice: 'skylar', phase: 'warm', attempts: 1, successes: 0, failures: 1,
      ttfa: { count: 0 }, total: { count: 0 } },
    { provider: 'deepgram', model: 'aura', voice: 'thalia', phase: 'cold', attempts: 1, successes: 1, failures: 0,
      ttfa: { count: 1, mean: 300, p50: 300, p90: 300, min: 300, max: 300 },
      total: { count: 1, mean: 900, p50: 900, p90: 900, min: 900, max: 900 } },
    { provider: 'deepgram', model: 'aura', voice: 'thalia', phase: 'warm', attempts: 1, successes: 1, failures: 0,
      ttfa: { count: 1, mean: 30, p50: 30, p90: 30, min: 30, max: 30 },
      total: { count: 1, mean: 600, p50: 600, p90: 600, min: 600, max: 600 } },
  ]);
});

test('Deepgram benchmark provider reuses one socket and resolves on Flushed', async () => {
  class FakeSocket extends EventEmitter {
    readyState = 0;
    readonly sent: string[] = [];
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(data: string): void {
      this.sent.push(data);
      if (JSON.parse(data).type !== 'Flush') return;
      queueMicrotask(() => {
        this.emit('message', Buffer.from([1, 2]), true);
        this.emit('message', Buffer.from([3, 4]), true);
        this.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
      });
    }
    close(): void { this.readyState = 3; this.emit('close'); }
  }
  let socket!: FakeSocket;
  const provider = deepgramTtsBenchmarkProvider('key', 'aura-2-thalia-en', () => (socket = new FakeSocket()) as never);
  const session = await provider.open();
  const result = await session.synthesize('Hello.');
  assert.deepEqual(result.audio, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(socket.sent.map(message => JSON.parse(message).type), ['Speak', 'Flush']);
  await session.close();
});

test('Cartesia benchmark provider collects decoded context chunks until done', async () => {
  let transcript = '';
  let closed = false;
  const client = { tts: { websocket: async () => ({
    context: () => ({ push: async ({ transcript: value }: { transcript: string }) => { transcript += value; },
      no_more_inputs: async () => {}, receive: async function* () {
        yield { type: 'chunk', audio: Uint8Array.from([5, 6]) };
        yield { type: 'done' };
      } }),
    close: () => { closed = true; },
  }) } };
  const provider = cartesiaTtsBenchmarkProvider('key', 'voice-id', 'sonic-3.6', () => client as never);
  const session = await provider.open();
  const result = await session.synthesize('Hi there.');
  assert.equal(transcript, 'Hi there.');
  assert.deepEqual(result.audio, Buffer.from([5, 6]));
  await session.close();
  assert.equal(closed, true);
});

test('TTS benchmark reopens for each cold/warm pair and includes handshake only in cold latency', async () => {
  let opens = 0;
  let closes = 0;
  const clips: string[] = [];
  const provider: TtsBenchmarkProvider = { name: 'fake', model: 'm', voice: 'v', sampleRate: 16_000,
    open: async () => {
      opens++;
      return { connectMs: 100, synthesize: async text => ({ ttfaMs: 20, totalMs: 40,
        audio: Buffer.from(text) }), close: async () => { closes++; } };
    } };
  const samples = await runTtsBenchmark([provider], [
    { id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: 'three' }, { id: 'd', text: 'four' },
  ], async (sample, audio) => { clips.push(`${sample.textId}:${audio.toString()}`); });

  assert.deepEqual(samples.map(sample => ({ id: sample.textId, phase: sample.phase, connect: sample.connectMs,
    ttfa: sample.ttfaMs, total: sample.totalMs })), [
    { id: 'a', phase: 'cold', connect: 100, ttfa: 120, total: 140 },
    { id: 'b', phase: 'warm', connect: 0, ttfa: 20, total: 40 },
    { id: 'c', phase: 'cold', connect: 100, ttfa: 120, total: 140 },
    { id: 'd', phase: 'warm', connect: 0, ttfa: 20, total: 40 },
  ]);
  assert.deepEqual(clips, ['a:one', 'b:two', 'c:three', 'd:four']);
  assert.equal(opens, 2);
  assert.equal(closes, 2);
});

test('blind rating sheet exposes no provider identity and has one auditable row per randomized clip', () => {
  const csv = renderBlindRatingCsv(['clip-003', 'clip-001']);
  assert.equal(csv, [
    'blind_id,naturalness_1_5,pronunciation_1_5,pacing_1_5,technical_clarity_1_5,preference_rank,notes',
    'clip-003,,,,,,',
    'clip-001,,,,,,',
    '',
  ].join('\n'));
  assert.doesNotMatch(csv, /deepgram|cartesia|sonic|aura/i);
});
