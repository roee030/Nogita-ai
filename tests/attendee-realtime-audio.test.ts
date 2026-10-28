import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { assembleNova3Turn, createAttendeeAudioSocketUrl, hasNova3SpeechActivity, parseAttendeeAudioFrame,
  verifyAttendeeAudioSignature, AttendeeRealtimeAudioHub } from '../src/app/attendee-realtime-audio.ts';

test('audio socket URL is WSS-only and signed for one meeting session', () => {
  const url = createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test-secret', 'meeting-1');
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'wss:');
  assert.equal(parsed.searchParams.get('session_id'), 'meeting-1');
  assert.equal(verifyAttendeeAudioSignature('test-secret', 'meeting-1', parsed.searchParams.get('signature')!), true);
  assert.equal(verifyAttendeeAudioSignature('test-secret', 'meeting-2', parsed.searchParams.get('signature')!), false);
  assert.throws(() => createAttendeeAudioSocketUrl('ws://nogita.example/audio', 'test-secret', 'meeting-1'), /WSS/);
  assert.throws(() => createAttendeeAudioSocketUrl('wss://user:pass@nogita.example/webhooks/attendee/audio', 'test-secret', 'meeting-1'), /credential-free/);
});

test('Attendee audio frame parser accepts only valid per-participant PCM frames', () => {
  const raw = Buffer.alloc(3200, 1);
  const payload = { bot_id: 'bot_123abc', trigger: 'realtime_audio.per_participant', data: {
    participant_uuid: 'participant_abc', chunk: raw.toString('base64'), sample_rate: 16000,
  } };
  const frame = parseAttendeeAudioFrame(payload, 'bot_123abc');
  assert.equal(frame?.participantUuid, 'participant_abc');
  assert.equal(frame?.audio.equals(raw), true);
  assert.equal(parseAttendeeAudioFrame(payload, 'bot_other'), null);
  assert.equal(parseAttendeeAudioFrame({ ...payload, trigger: 'realtime_audio.mixed' }, 'bot_123abc'), null);
  assert.equal(parseAttendeeAudioFrame({ ...payload, data: { ...payload.data, sample_rate: 24000 } }, 'bot_123abc'), null);
  assert.equal(parseAttendeeAudioFrame({ ...payload, data: { ...payload.data, chunk: 'not-base64' } }, 'bot_123abc'), null);
  assert.equal(parseAttendeeAudioFrame({ ...payload, data: { ...payload.data, chunk: Buffer.alloc(70_000).toString('base64') } }, 'bot_123abc'), null);
});

test('Nova-3 ignores interim hypotheses and emits one assembled stable turn per speaker stream', () => {
  const segments: string[] = [];
  assert.equal(assembleNova3Turn({ is_final: false, speech_final: false,
    channel: { alternatives: [{ transcript: 'Nogita, please' }] } }, segments), null);
  assert.equal(assembleNova3Turn({ is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: 'Nogita, please' }] } }, segments), null);
  assert.equal(assembleNova3Turn({ is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: 'open a task' }] } }, segments), 'Nogita, please open a task');
  assert.deepEqual(segments, []);
  assert.equal(assembleNova3Turn({ is_final: false, speech_final: false,
    channel: { alternatives: [{ transcript: 'unfinished' }] } }, segments), null);
  assert.deepEqual(segments, []);
});

test('Nova-3 exposes only non-empty interim/final-segment speech activity to the quiet-window guard', () => {
  assert.equal(hasNova3SpeechActivity({ is_final: false, speech_final: false,
    channel: { alternatives: [{ transcript: 'I am still talking' }] } }), true);
  assert.equal(hasNova3SpeechActivity({ is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: 'next thought' }] } }), true);
  assert.equal(hasNova3SpeechActivity({ is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: 'finished' }] } }), false);
  assert.equal(hasNova3SpeechActivity({ is_final: false, speech_final: false,
    channel: { alternatives: [{ transcript: '' }] } }), false);
});

test('signed Attendee socket reconnect restores only a bot/session pair confirmed by persisted binding', async () => {
  const server = createServer();
  let recovery!: (sessionId: string, botId: string) => Promise<boolean>;
  const authorized = new Promise<void>(resolve => { recovery = async (sessionId, botId) => {
    assert.equal(sessionId, 'meeting-recovered');
    assert.equal(botId, 'bot_persisted');
    resolve();
    return true;
  }; });
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'unused-test-key', onTranscript: () => {},
    authorizeRecoveredBot: (sessionId, botId) => recovery(sessionId, botId) });
  server.on('upgrade', (request, socket, head) => { assert.equal(hub.handleUpgrade(request, socket, head), true); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'meeting-recovered'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${address.port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  client.send(JSON.stringify({ trigger: 'test', bot_id: 'bot_persisted' }));
  await authorized;
  assert.equal(hub.hasSession('meeting-recovered'), true);
  client.close();
  hub.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
