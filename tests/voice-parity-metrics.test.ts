import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, render } from '../tools/turn-report.ts';
import { runAgent, type ChatModel } from '../src/core/agent.ts';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub } from '../src/app/attendee-realtime-audio.ts';
import { record as recordLabTurn } from '../tools/voice-lab/conversation.ts';
import { scoreTurn } from '../tools/voice-lab/score.ts';

test('adopted speculation measures latency from the confirmed transcript, not an earlier question', () => {
  const report = analyse('s', [
    { at: 0, type: 'heard', speaker: 'p', addressed: true, verified: true },
    { at: 100, type: 'question', id: 1, speaker: 'p', status: 'speculative' },
    { at: 500, type: 'heard', speaker: 'p', addressed: true, verified: true },
    { at: 510, type: 'question', id: 1, speaker: 'p', status: 'working' },
    { at: 520, type: 'question', id: 1, speaker: 'p', status: 'working' },
    { at: 550, type: 'speech', id: 1, phase: 'start' },
    { at: 600, type: 'audio', phase: 'start' },
    { at: 800, type: 'question', id: 1, speaker: 'p', status: 'answered' },
    { at: 900, type: 'question', id: 2, speaker: 'p', status: 'speculative' },
    { at: 950, type: 'question', id: 2, speaker: 'p', status: 'rolled_back' },
    { at: 960, type: 'question', id: 2, speaker: 'p', status: 'rolled_back' },
    { at: 1000, type: 'question', id: 3, speaker: 'p', status: 'speculative' },
  ]);
  assert.deepEqual(report.firstAudioMs, [100]);
  assert.deepEqual(report.speculation, { started: 3, adopted: 1, rolledBack: 1, unresolved: 1 });
  assert.equal(report.questions, 1);
  assert.deepEqual(report.finals, { answered: 1 });
  assert.deepEqual(report.missed, []);
});

test('missing transcript timing stays unknown; model and EOT timing reject invalid samples', () => {
  const report = analyse('s', [
    { at: 0, type: 'question', id: 1, speaker: 'p', status: 'working' },
    { at: 10, type: 'speech', id: 1, phase: 'start' },
    { at: 30, type: 'audio', phase: 'start' },
    { at: 40, type: 'model_first_text', id: 1, step: 0, ms: 100 },
    { at: 41, type: 'model_first_text', id: 1, step: 0, ms: 100 },
    { at: 42, type: 'model_first_text', id: 1, step: 1, ms: -1 },
    { at: 43, type: 'model_first_text', id: 2, step: 0, ms: Infinity },
    { at: 44, type: 'eot', phase: 'eager', sinceLastVoiceMs: 50 },
    { at: 45, type: 'eot', phase: 'confirmed', sinceLastVoiceMs: 400 },
    { at: 46, type: 'eot', phase: 'confirmed' },
    { at: 47, type: 'eot', phase: 'confirmed', sinceLastVoiceMs: -1 },
  ]);
  assert.deepEqual(report.firstAudioMs, []);
  assert.deepEqual(report.firstTextMs, [100]);
  assert.deepEqual(report.eotSinceVoiceMs, [400]);
  assert.match(render([report]), /n\/a \(n=0\)/);
});

test('explicit audio owners override latest speech and duplicate playback starts do not inflate samples', () => {
  const r = analyse('s', [
    { at: 0, type: 'heard', speaker: 'a', addressed: true, verified: true },
    { at: 1, type: 'question', id: 1, speaker: 'a', status: 'working' },
    { at: 10, type: 'question', id: 1, speaker: 'a', status: 'cancelled' },
    { at: 20, type: 'heard', speaker: 'b', addressed: true, verified: true },
    { at: 21, type: 'question', id: 2, speaker: 'b', status: 'working' },
    { at: 30, type: 'speech', id: 2, playbackId: 2, phase: 'start' },
    { at: 40, type: 'audio', id: 1, playbackId: 1, phase: 'start', ttfaMs: 39 },
    { at: 41, type: 'audio', id: 1, playbackId: 1, phase: 'start', ttfaMs: 39 },
    { at: 50, type: 'audio', id: 2, playbackId: 2, phase: 'start', ttfaMs: 20 },
  ]);
  assert.equal(r.staleAudio, 1);
  assert.deepEqual(r.ttsFirstAudioMs, [39, 20]);
  assert.deepEqual(r.firstAudioMs, [40, 30]);
});

test('input IDs attribute an unnamed follow-up and merged turns without borrowing another speakers timestamp', () => {
  const r = analyse('s', [
    { at: 10, type: 'heard', inputTurnId: 'first', speaker: 'same', addressed: false, verified: true },
    { at: 20, type: 'heard', inputTurnId: 'last', speaker: 'same', addressed: false, verified: true },
    { at: 25, type: 'heard', inputTurnId: 'other', speaker: 'same', addressed: true, verified: true },
    { at: 30, type: 'question', id: 1, inputTurnIds: ['first', 'last'], speaker: 'same', status: 'working' },
    { at: 60, type: 'audio', id: 1, playbackId: 1, phase: 'start' },
    { at: 70, type: 'question', id: 2, inputTurnIds: ['missing'], speaker: 'same', status: 'working' },
    { at: 80, type: 'audio', id: 2, playbackId: 2, phase: 'start' },
  ]);
  assert.deepEqual(r.firstAudioMs, [40]);
});

test('lab distinguishes a delayed command stop from a false voice interruption and enforces 300ms', () => {
  const turn = { speaker: 'a', say: 'Nogita, stop.', bargeIn: { afterAudioMs: 0 }, expect: { respond: 'any' as const } };
  const command = recordLabTurn([
    { t: 1500, type: 'interrupt', cause: 'command' },
    { t: 1501, type: 'speak_error', detail: 'speech interrupted' },
    { t: 1700, type: 'audio_stop' },
  ], turn, 0, { start: 0, end: 1000 });
  assert.equal(command.interruptedByNoise, false);
  assert.equal(scoreTurn(command).checks.find(check => check.name === 'stops when interrupted')?.ok, false);
  const noise = recordLabTurn([{ t: 1500, type: 'interrupt', cause: 'voice', latencyMs: 100 }], turn, 0, { start: 0, end: 1000 });
  assert.equal(noise.interruptedByNoise, true);
  const late = recordLabTurn([{ t: 1500, type: 'interrupt', cause: 'voice', latencyMs: 600 }], turn, 0, { start: 0, end: 1000 });
  assert.equal(late.interruptedByNoise, false);
});

test('first text timing is once per model step, excludes tools-only steps and ignores late aborted deltas', async () => {
  let now = 0;
  let calls = 0;
  const abort = new AbortController();
  const timings: Array<[number, number]> = [];
  const model: ChatModel = { agentModel: 'fake', streamChat: async (_request, delta) => {
    calls++;
    now += 100;
    delta('');
    if (calls === 1) return { content: [{ type: 'tool_use', id: 'r', name: 'read', input: {} }], stopReason: 'tool_use' };
    delta('Hello');
    now += 100;
    delta(' world.');
    return { content: [{ type: 'text', text: 'Hello world.' }], stopReason: 'end_turn' };
  } };
  const turn = { stableSystem: '', turnSystem: '', messages: [], stream: true, now: () => now,
    signal: abort.signal, onFirstText: (step: number, ms: number) => timings.push([step, ms]),
    toolbox: { specs: [], isWrite: () => false, run: async () => ({ content: 'found' }) } };
  await runAgent(model, turn);
  assert.deepEqual(timings, [[1, 100]]);
  timings.length = 0;
  await runAgent({ agentModel: 'late', streamChat: async (_request, delta) => {
    abort.abort();
    delta('stale');
    return { content: [], stopReason: 'end_turn' };
  } }, turn);
  assert.deepEqual(timings, []);
});

test('Flux timing follows actual own-voice frames, ignores silence and does not reuse a prior turn', () => {
  let now = 100;
  const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send() {}, close() {} });
  const events: Array<{ phase: string; sinceLastVoiceMs?: number }> = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 's', deepgramApiKey: 'k', sttMode: 'flux-english', now: () => now,
    onTranscript: () => {}, onTurnTiming: (_session, _participant, { inputTurnId: _id, ...event }) => events.push(event),
    createWebSocket: () => socket as unknown as WebSocket });
  hub.register('s'); hub.bindBot('s', 'bot_test');
  const internals = hub as unknown as { sessions: Map<string, unknown>;
    processAttendeeFrame: (id: string, session: unknown, frame: unknown) => void };
  const frame = (pcm: Buffer) => internals.processAttendeeFrame('s', internals.sessions.get('s'), {
    bot_id: 'bot_test', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'p', sample_rate: 16000, chunk: pcm.toString('base64') } });
  const emit = (event: string) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event, transcript: '' })), false);
  try {
    const voiced = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) voiced.writeInt16LE(6000, i * 2);
    frame(voiced);
    now = 200; frame(Buffer.alloc(3200));
    now = 300; emit('EagerEndOfTurn');
    now = 350; emit('TurnResumed');
    now = 400; frame(voiced);
    now = 800; emit('EndOfTurn');
    now = 900; emit('EagerEndOfTurn');
    assert.deepEqual(events, [
      { phase: 'eager', sinceLastVoiceMs: 200 }, { phase: 'resumed', sinceLastVoiceMs: 250 },
      { phase: 'confirmed', sinceLastVoiceMs: 400 }, { phase: 'eager' },
    ]);
  } finally { hub.close(); }
});
