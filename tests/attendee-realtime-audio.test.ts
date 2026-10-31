import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { assembleNova3Turn, createAttendeeAudioSocketUrl, hasFluxSpeechActivity, hasNova3SpeechActivity, parseAttendeeAudioFrame,
  verifyAttendeeAudioSignature, AttendeeRealtimeAudioHub, isBackchannel } from '../src/app/attendee-realtime-audio.ts';

/** A speaking-level tone; silence would be rejected by the own-voice gate. */
function voiceChunk(amplitude = 0.2, durationMs = 100): string {
  const samples = Math.round(16_000 * durationMs / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 220 * i / 16000)), i * 2);
  return pcm.toString('base64');
}

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

test('Flux emits one completed speaker turn only on EndOfTurn', () => {
  const segments: string[] = [];
  assert.equal(assembleNova3Turn({ type: 'TurnInfo', event: 'Update', turn_index: 3,
    transcript: 'Nogita, please' }, segments), null);
  assert.equal(assembleNova3Turn({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 3,
    transcript: 'Nogita, please open a task' }, segments), 'Nogita, please open a task');
  assert.deepEqual(segments, []);
});

test('Flux resets the turn guard when speech starts or resumes', () => {
  assert.equal(hasFluxSpeechActivity({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' }), true);
  assert.equal(hasFluxSpeechActivity({ type: 'TurnInfo', event: 'Update', transcript: 'still speaking' }), true);
  assert.equal(hasFluxSpeechActivity({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'done' }), false);
});

test('backchannel classification keeps acknowledgements but never swallows interruption words', () => {
  for (const text of ['yeah', 'Right.', 'mm-hm', 'mhm', 'uh-huh', 'okay', 'got it', 'I see']) {
    assert.equal(isBackchannel(text), true, text);
  }
  for (const text of ['no', 'wait', 'stop', 'actually', 'hold on', 'I disagree', 'can I add something']) {
    assert.equal(isBackchannel(text), false, text);
  }
});

test('English Flux socket waits for EndOfTurn and keeps multilingual Nova-3 as the default', async () => {
  for (const sttMode of [undefined, 'flux-english'] as const) {
    class FakeStt extends EventEmitter {
      readyState: number = WebSocket.CONNECTING;
      send(): void { /* PCM reaches the fake recognizer. */ }
      close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
    }
    const server = createServer();
    const received: string[] = [];
    let created!: (value: { url: string; socket: FakeStt }) => void;
    const sttCreated = new Promise<{ url: string; socket: FakeStt }>(resolve => { created = resolve; });
    const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
      signingSecret: 'test-secret', deepgramApiKey: 'test-key', sttMode,
      onTranscript: (_sessionId, _participantUuid, transcript) => { received.push(transcript); },
      createWebSocket: url => {
        const socket = new FakeStt();
        created({ url, socket });
        queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
        return socket as unknown as WebSocket;
      } });
    hub.register('stt-mode-test');
    hub.bindBot('stt-mode-test', 'bot_test');
    server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
      'test-secret', 'stt-mode-test'));
    signed.protocol = 'ws:';
    signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new WebSocket(signed);
    try {
      await once(client, 'open');
      client.send(JSON.stringify({ bot_id: 'bot_test', trigger: 'realtime_audio.per_participant', data: {
        participant_uuid: 'participant_one', sample_rate: 16000, chunk: voiceChunk(),
      } }));
      const { url, socket } = await sttCreated;
      assert.match(url, sttMode === 'flux-english' ? /\/v2\/listen\?model=flux-general-en/ : /\/v1\/listen\?model=nova-3/);
      assert.equal(new URL(url).searchParams.get('mip_opt_out'), 'true');
      const interim = sttMode === 'flux-english'
        ? { type: 'TurnInfo', event: 'Update', transcript: 'Nogita, wait' }
        : { type: 'Results', is_final: false, speech_final: false,
          channel: { alternatives: [{ transcript: 'Nogita, wait' }] } };
      socket.emit('message', Buffer.from(JSON.stringify(interim)), false);
      assert.deepEqual(received, []);
      const completed = sttMode === 'flux-english'
        ? { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 1, transcript: 'Nogita, answer me' }
        : { type: 'Results', is_final: true, speech_final: true,
          channel: { alternatives: [{ transcript: 'Nogita, answer me' }] } };
      socket.emit('message', Buffer.from(JSON.stringify(completed)), false);
      socket.emit('message', Buffer.from(JSON.stringify(completed)), false);
      assert.deepEqual(received, ['Nogita, answer me']);
    } finally {
      client.terminate(); hub.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
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

test('Nova-3 closes a turn on UtteranceEnd when steady noise keeps speech_final from arriving', () => {
  const segments: string[] = [];
  assert.equal(assembleNova3Turn({ is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: 'Nogita, what changed' }] } }, segments), null);
  assert.equal(assembleNova3Turn({ is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: 'in the last commits?' }] } }, segments), null);
  assert.equal(assembleNova3Turn({ type: 'UtteranceEnd', last_word_end: 3.1 }, segments), 'Nogita, what changed in the last commits?');
  assert.equal(assembleNova3Turn({ type: 'UtteranceEnd', last_word_end: 3.1 }, segments), null);
});

test('a slow Deepgram handshake keeps the first seconds of speech instead of reopening the stream', async () => {
  class SlowStt extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    readonly sent: Buffer[] = [];
    closed = false;
    send(audio: Buffer): void { this.sent.push(audio); }
    close(): void { this.closed = true; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const sockets: Array<{ url: string; socket: SlowStt }> = [];
  const server = createServer();
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {},
    createWebSocket: url => { const socket = new SlowStt(); sockets.push({ url, socket }); return socket as unknown as WebSocket; } });
  hub.register('slow-stt');
  hub.bindBot('slow-stt', 'bot_test');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test-secret', 'slow-stt'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  try {
    await once(client, 'open');
    // Two seconds of 20 ms frames while the recognizer is still connecting.
    for (let i = 0; i < 100; i++) {
      client.send(JSON.stringify({ bot_id: 'bot_test', trigger: 'realtime_audio.per_participant', data: {
        participant_uuid: 'participant_one', sample_rate: 16000, chunk: Buffer.alloc(640, i % 250).toString('base64') } }));
    }
    for (let i = 0; i < 50 && !(sockets.length && sockets[0]!.socket.listenerCount('open')); i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]!.socket.closed, false);
    assert.match(sockets[0]!.url, /keyterm=Nogita/);
    assert.match(sockets[0]!.url, /utterance_end_ms=1000/);
    sockets[0]!.socket.readyState = WebSocket.OPEN;
    sockets[0]!.socket.emit('open');
    // Half a second of lead-in silence, then every buffered frame.
    assert.equal(sockets[0]!.socket.sent.length, 101);
    assert.equal(sockets[0]!.socket.sent[0]!.length, 16_000);
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function hubWithFakeStt(sttMode?: 'flux-english') {
  class FakeStt extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    readonly sent: Buffer[] = [];
    send(audio: Buffer): void { this.sent.push(audio); }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const sockets: FakeStt[] = [];
  const received: string[] = [];
  const server = createServer();
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', sttMode,
    onTranscript: (_s, _p, text) => { received.push(text); },
    createWebSocket: () => { const socket = new FakeStt(); sockets.push(socket); return socket as unknown as WebSocket; } });
  hub.register('fake-stt');
  hub.bindBot('fake-stt', 'bot_test');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test-secret', 'fake-stt'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  const frame = (amplitude: number) => client.send(JSON.stringify({ bot_id: 'bot_test', trigger: 'realtime_audio.per_participant',
    data: { participant_uuid: 'participant_one', sample_rate: 16000, chunk: voiceChunk(amplitude) } }));
  const close = async () => { client.terminate(); hub.close(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { sockets, received, frame, close };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('when a participant mutes right after speaking, the recognizer gets silence so it can end the turn', async () => {
  const lab = await hubWithFakeStt();
  try {
    for (let i = 0; i < 5; i++) lab.frame(0.2);
    await wait(700);
    const sent = lab.sockets[0]!.sent;
    const silent = sent.filter(audio => audio.length === 3_200 && audio.every(byte => byte === 0));
    assert.ok(sent.length - silent.length >= 5);
    assert.ok(silent.length >= 3, `silence frames: ${silent.length}`);
  } finally { await lab.close(); }
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

test('interrupting speech clears pending Deepgram audio and releases the spoken turn', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    sent: string[] = [];
    send(value: string): void { this.sent.push(value); }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  const tts = new FakeTts();
  let ttsUrl = '';
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', ttsModel: 'aura-2-luna-en', onTranscript: () => {},
    createWebSocket: url => {
      ttsUrl = url;
      queueMicrotask(() => { tts.readyState = WebSocket.OPEN; tts.emit('open'); });
      return tts as unknown as WebSocket;
    } });
  hub.register('interrupt-test');
  hub.bindBot('interrupt-test', 'bot_interruption');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'interrupt-test'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  const speaking = hub.speak('interrupt-test', 'This answer should stop.');
  void speaking.catch(() => undefined);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(ttsUrl, /\/v1\/speak\?model=aura-2-luna-en/);
    assert.equal(new URL(ttsUrl).searchParams.get('mip_opt_out'), 'true');
    assert.equal(tts.sent.some(message => message.includes('Speak')), true);
    assert.equal(hub.interruptSpeech('interrupt-test'), true);
    await assert.rejects(speaking, /interrupted/);
    assert.equal(tts.sent.at(-1), JSON.stringify({ type: 'Clear' }));
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('human interruption drops queued Attendee audio instead of sending the whole answer ahead', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Deepgram accepts the speech request. */ }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  const sockets: FakeTts[] = [];
  const frames: unknown[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {},
    createWebSocket: () => {
      const socket = new FakeTts();
      sockets.push(socket);
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('paced-output-test');
  hub.bindBot('paced-output-test', 'bot_paced');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'paced-output-test'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  client.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await once(client, 'open');
  const speaking = hub.speak('paced-output-test', 'A long answer that should stop when I speak.');
  void speaking.catch(() => undefined);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    sockets[0]!.emit('message', Buffer.alloc(9_600, 1), true);
    sockets[0]!.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(frames.length, 1);
    assert.equal(hub.interruptSpeech('paced-output-test'), true);
    await assert.rejects(speaking, /interrupted/);
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    assert.equal(frames.length, 1);
    const resumed = hub.speak('paced-output-test', 'A new short answer.');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 2);
    sockets[1]!.emit('message', Buffer.alloc(6_400, 2), true);
    sockets[1]!.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await resumed;
    assert.equal(frames.length, 3);
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('late audio and Flushed from an interrupted TTS turn cannot finish the next turn', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Accept request. */ }
    close(): void { this.readyState = WebSocket.CLOSED; }
  }
  const server = createServer();
  const sockets: FakeTts[] = [];
  const frames: unknown[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {},
    createWebSocket: () => {
      const socket = new FakeTts();
      sockets.push(socket);
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('stale-output-test');
  hub.bindBot('stale-output-test', 'bot_stale');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'stale-output-test'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  client.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await once(client, 'open');
  try {
    const first = hub.speak('stale-output-test', 'First answer.');
    void first.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(hub.interruptSpeech('stale-output-test'), true);
    await assert.rejects(first, /interrupted/);
    const second = hub.speak('stale-output-test', 'Second answer.');
    let secondSettled = false;
    void second.finally(() => { secondSettled = true; }).catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 2);
    sockets[0]!.emit('message', Buffer.alloc(3_200, 1), true);
    sockets[0]!.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    sockets[0]!.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false);
    assert.equal(frames.length, 0);
    sockets[1]!.emit('message', Buffer.alloc(3_200, 2), true);
    sockets[1]!.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await second;
    assert.equal(frames.length, 1);
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('completed synthesis is not timed out while its paced audio is still playing', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Accept request. */ }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  const tts = new FakeTts();
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', ttsSynthesisTimeoutMs: 40,
    onTranscript: () => {}, createWebSocket: () => {
      queueMicrotask(() => { tts.readyState = WebSocket.OPEN; tts.emit('open'); });
      return tts as unknown as WebSocket;
    } });
  hub.register('long-playback-test');
  hub.bindBot('long-playback-test', 'bot_long_playback');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'long-playback-test'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  try {
    const speaking = hub.speak('long-playback-test', 'A longer spoken answer.');
    await new Promise<void>(resolve => setImmediate(resolve));
    tts.emit('message', Buffer.alloc(6_400, 1), true);
    tts.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await speaking;
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a short recognized backchannel does not interrupt an in-progress answer', async () => {
  class FakeProviderSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Accept audio and speech requests. */ }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  let stt!: FakeProviderSocket;
  let tts!: FakeProviderSocket;
  const frames: unknown[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', sttMode: 'flux-english', onTranscript: () => {},
    createWebSocket: url => {
      const socket = new FakeProviderSocket();
      if (url.includes('/listen')) stt = socket;
      if (url.includes('/speak')) tts = socket;
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('nova-backchannel');
  hub.bindBot('nova-backchannel', 'bot_backchannel');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'nova-backchannel'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  client.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await once(client, 'open');
  try {
    client.send(JSON.stringify({ bot_id: 'bot_backchannel', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0),
    } }));
    while (!stt) await new Promise<void>(resolve => setImmediate(resolve));
    const speaking = hub.speak('nova-backchannel', 'A long answer.');
    void speaking.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    tts.emit('message', Buffer.alloc(6_400, 1), true);
    tts.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await wait(20);
    assert.equal(frames.length, 1, 'first paced frame is playing');
    client.send(JSON.stringify({ bot_id: 'bot_backchannel', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(),
    } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    // Flux emits a wordless StartOfTurn before its first hypothesis. It is evidence to hold the pause, not
    // evidence that the utterance is an interruption. The first backchannel hypothesis resumes queued audio.
    stt.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' })), false);
    stt.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'yeah' })), false);
    await speaking;
    assert.equal(frames.length, 2, 'queued answer resumed after the backchannel hypothesis');
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('own voice pauses output within 300 ms, then sustained speech cancels if recognition never arrives', async () => {
  class FakeProviderSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Accept audio and speech requests. */ }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  let stt!: FakeProviderSocket;
  let clock = 800;
  const interrupts: Array<{ latencyMs?: number }> = [];
  const pauses: Array<{ latencyMs: number; remainingMs: number }> = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {},
    now: () => clock, onInterrupt: (_sessionId, event) => interrupts.push(event),
    onSpeechPause: (_sessionId, event) => pauses.push(event),
    createWebSocket: url => {
      const socket = new FakeProviderSocket();
      if (url.includes('/listen')) stt = socket;
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('nova-barge-in');
  hub.bindBot('nova-barge-in', 'bot_nova');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio',
    'test-secret', 'nova-barge-in'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  try {
    // Open the participant stream without qualifying as own voice yet.
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0),
    } }));
    while (!stt) await new Promise<void>(resolve => setImmediate(resolve));
    // A prior louder utterance must not make the next, quieter one invisible to the own-voice gate.
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0.4),
    } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    clock = 900;
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0),
    } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const speaking = hub.speak('nova-barge-in', 'A long answer.');
    void speaking.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    clock = 1_100;
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0.15),
    } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    // A short phonetic valley inside a word must not restart the acoustic-onset clock.
    clock = 1_170;
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0),
    } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    // The next contiguous 100 ms frame arrived 150 ms later. Output must pause within the acoustic budget,
    // even though permanent cancellation waits long enough for a short acknowledgement to be recognized.
    clock = 1_250;
    client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
      participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0.15),
    } }));
    const pausedOutcome = await Promise.race([
      speaking.then(() => 'resolved', error => error instanceof Error && /interrupted/.test(error.message) ? 'interrupted' : 'failed'),
      wait(20).then(() => 'still-speaking'),
    ]);
    assert.equal(pausedOutcome, 'still-speaking');
    assert.ok((pauses[0]?.latencyMs ?? Infinity) <= 300, JSON.stringify(pauses));

    // No recognition ever arrives. Continuous speech keeps the output paused and eventually abandons the old answer.
    for (clock = 1_400; clock <= 2_600; clock += 100) {
      client.send(JSON.stringify({ bot_id: 'bot_nova', trigger: 'realtime_audio.per_participant', data: {
        participant_uuid: 'human_one', sample_rate: 16000, chunk: voiceChunk(0.15),
      } }));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const outcome = await Promise.race([
      speaking.then(() => 'resolved', error => error instanceof Error && /interrupted/.test(error.message) ? 'interrupted' : 'failed'),
      wait(100).then(() => 'timeout'),
    ]);
    assert.equal(outcome, 'interrupted');
    assert.ok((interrupts[0]?.latencyMs ?? Infinity) <= 1_600, JSON.stringify(interrupts));
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('realtime audio rejects unsupported voice model identifiers before joining a meeting', () => {
  assert.throws(() => new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', ttsModel: 'flux-alexis-en',
    onTranscript: () => {} }), /TTS model/i);
});

test('with warm speech the TTS connection opens when meeting audio connects and again after an interruption', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void { /* Deepgram accepts the speech request. */ }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  const sockets: FakeTts[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {}, warmSpeech: true,
    createWebSocket: () => {
      const socket = new FakeTts();
      sockets.push(socket);
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('warm-test');
  hub.bindBot('warm-test', 'bot_warm');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test-secret', 'warm-test'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  try {
    await once(client, 'open');
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(sockets.length, 1, 'opened before anything was said');
    const speaking = hub.speak('warm-test', 'Hello there.');
    void speaking.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 1, 'the first answer reuses the warm connection');
    assert.equal(hub.interruptSpeech('warm-test'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.length, 2, 'a fresh connection is ready for the next answer');
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
