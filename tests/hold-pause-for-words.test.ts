import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, createAttendeeAudioSocketUrl } from '../src/app/attendee-realtime-audio.ts';

function chunk(amplitude: number, ms = 100): string {
  const samples = new Int16Array(16 * ms);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 3) * amplitude * 32_767);
  return Buffer.from(samples.buffer).toString('base64');
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * She is answering; Roee talks over her, loud for a moment, then quieter (Meet's echo cancellation), and his words
 * reach recognition only after `wordsAfterMs`. Live Meet 2026-11-03: "I told you wait a second stop".
 */
async function talkOver(words: string, holdPauseForWords: boolean, wordsAfterMs = 1_700) {
  class Fake extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void {}
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  let stt!: Fake, tts!: Fake;
  const log: string[] = [];
  const server = createServer();
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio', signingSecret: 's',
    deepgramApiKey: 'k', sttMode: 'flux-english', turnTakingV2: true, holdPauseForWords, onTranscript: () => {},
    onSpeechPause: () => log.push('pause'), onSpeechResume: (_s, e) => log.push(`resume:${e.cause}`),
    onInterrupt: (_s, e) => log.push(`interrupt:${e.cause}`),
    createWebSocket: url => {
      const socket = new Fake();
      if (url.includes('/listen')) stt = socket;
      if (url.includes('/speak')) tts = socket;
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('m');
  hub.bindBot('m', 'bot_m');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 's', 'm'));
  url.protocol = 'ws:';
  url.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(url);
  await once(client, 'open');
  const frame = (amplitude: number) => client.send(JSON.stringify({ bot_id: 'bot_m', trigger: 'realtime_audio.per_participant',
    data: { participant_uuid: 'roee', sample_rate: 16000, chunk: chunk(amplitude) } }));
  try {
    frame(0);
    while (!stt) await new Promise<void>(resolve => setImmediate(resolve));
    const speaking = hub.speak('m', 'I can answer engineering questions and look things up for the team.');
    void speaking.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let i = 0; i < 8; i++) tts.emit('message', Buffer.alloc(32_000, 1), true);
    await wait(20);
    frame(0.3); await wait(5); frame(0.3);           // he starts talking: the level gate opens, she pauses
    await wait(20);
    stt.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' })), false);
    for (let t = 0; t < wordsAfterMs; t += 100) { frame(0.01); await wait(100); } // quieter: the gate closes
    stt.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: words })), false);
    await wait(30);
    return log;
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('NOGITA_HOLD_PAUSE_FOR_WORDS: words that come after 1.5 s still end her answer instead of her talking on', async () => {
  const on = await talkOver('I told you wait a second', true);
  assert.equal(on[0], 'pause');
  assert.ok(!on.some(event => event.startsWith('resume')), on.join(','));
  assert.ok(on.includes('interrupt:voice'), on.join(','));
  const off = await talkOver('I told you wait a second', false);
  assert.ok(off.includes('resume:timeout'), `off: she resumes after 1.5 s, as in the Meet (${off.join(',')})`);
  assert.ok(!off.includes('interrupt:voice'), off.join(','));
});

test('a late "mm-hm" still lets her go on', async () => {
  const log = await talkOver('mm-hm', true);
  assert.ok(log.includes('resume:backchannel'), log.join(','));
  assert.ok(!log.some(event => event.startsWith('interrupt')), log.join(','));
});
