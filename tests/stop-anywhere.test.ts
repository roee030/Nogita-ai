import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, createAttendeeAudioSocketUrl } from '../src/app/attendee-realtime-audio.ts';
import { isStopCommand } from '../src/core/engine.ts';

/** Live Meet 2026-11-03: the line that should have stopped her, and lines that must not. */
const STOPS = ['I told you wait a second stop', 'I told you wait', 'okay stop', 'hold on hold on', 'enough'];
const NOT_STOPS = ["don't stop, go on", 'yeah', 'can you stop the demo video', 'wait for the build', 'what are the open tasks'];

test('the Meet line and its partial hypotheses read as a stop; "don\'t stop" and "wait for" do not', () => {
  for (const text of STOPS) assert.equal(isStopCommand(text), true, text);
  for (const text of NOT_STOPS) assert.equal(isStopCommand(text), false, text);
});

function chunk(amplitude: number): string {
  const samples = new Int16Array(1_600).fill(Math.round(amplitude * 32_767));
  return Buffer.from(samples.buffer).toString('base64');
}

/** She is speaking; the speaker's audio is near silent (echo cancellation) and Flux sends one live hypothesis. */
async function interimWhileSpeaking(hypothesis: string, stopOnInterim: boolean): Promise<string[]> {
  class Fake extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void {}
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  let stt!: Fake, tts!: Fake;
  const interrupts: string[] = [];
  const server = createServer();
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio', signingSecret: 's',
    deepgramApiKey: 'k', sttMode: 'flux-english', turnTakingV2: true, stopOnInterim, onTranscript: () => {},
    onInterrupt: (_s, event) => interrupts.push(event.cause),
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
  try {
    client.send(JSON.stringify({ bot_id: 'bot_m', trigger: 'realtime_audio.per_participant', data: { participant_uuid: 'roee', sample_rate: 16000, chunk: chunk(0) } }));
    while (!stt) await new Promise<void>(resolve => setImmediate(resolve));
    const speaking = hub.speak('m', 'I can answer engineering questions and look things up for the team.');
    void speaking.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    tts.emit('message', Buffer.alloc(32_000, 1), true);
    await new Promise(resolve => setTimeout(resolve, 20));
    stt.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: hypothesis })), false);
    await new Promise(resolve => setTimeout(resolve, 20));
    return interrupts;
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('NOGITA_STOP_ON_INTERIM: "I told you wait a second stop" stops her at the first hypothesis, quiet voice or not', async () => {
  assert.deepEqual(await interimWhileSpeaking('I told you wait a second stop', true), ['command']);
  assert.deepEqual(await interimWhileSpeaking('I told you wait a second stop', false), [], 'off: as in the Meet, it waits');
  assert.deepEqual(await interimWhileSpeaking("don't stop, go on", true), []);
  assert.deepEqual(await interimWhileSpeaking('the build is green', true), []);
});
