import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, createAttendeeAudioSocketUrl } from '../src/app/attendee-realtime-audio.ts';

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open'); }
}

function fixture() {
  const sockets: Socket[] = [];
  const starts: unknown[] = [];
  const ends: unknown[] = [];
  const interrupts: unknown[] = [];
  let now = 100;
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test', deepgramApiKey: 'test', onTranscript: () => {}, now: () => now,
    onSpeechStart: (_s, event) => starts.push(event), onSpeechEnd: (_s, event) => ends.push(event),
    onInterrupt: (_s, event) => interrupts.push(event),
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; } });
  hub.register('s'); hub.bindBot('s', 'bot_test');
  const attendee = new Socket(); attendee.readyState = WebSocket.OPEN;
  const session = (hub as unknown as { sessions: Map<string, { attendeeSocket?: WebSocket; voiceOnsetAt?: number }> }).sessions.get('s')!;
  session.attendeeSocket = attendee as unknown as WebSocket;
  return { hub, sockets, starts, ends, interrupts, attendee, session, setNow: (value: number) => { now = value; } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('stop during TTS handshake settles immediately and never sends stale text after open', async () => {
  const f = fixture();
  try {
    const old = f.hub.speak('s', 'Old answer.', { questionId: 1, playbackId: 1 });
    const rejected = assert.rejects(old, /interrupted/);
    assert.equal(f.hub.interruptSpeech('s'), true);
    await rejected;
    assert.deepEqual(f.ends, [{ questionId: 1, playbackId: 1, outcome: 'interrupted', playedMs: 0 }]);
    const next = f.hub.speak('s', 'New answer.', { questionId: 2, playbackId: 2 });
    const nextRejected = assert.rejects(next, /interrupted/);
    f.sockets[0]!.open(); await tick();
    assert.equal(f.sockets[0]!.sent.some(text => text.includes('Old answer')), false);
    assert.equal(f.sockets[0]!.sent.some(text => text.includes('New answer')), true);
    assert.equal(f.hub.interruptSpeech('s'), true); await nextRejected;
    assert.deepEqual(f.starts, []);
  } finally { f.hub.close(); }
});

test('two speak calls cannot both acquire a connection still opening', async () => {
  const f = fixture();
  try {
    const first = f.hub.speak('s', 'First.');
    const rejected = assert.rejects(first, /interrupted/);
    await assert.rejects(f.hub.speak('s', 'Second.'), /already in progress/);
    f.hub.interruptSpeech('s'); await rejected;
  } finally { f.hub.close(); }
});

test('voice interruption during TTS handshake preserves owner and acoustic latency', async () => {
  const f = fixture();
  try {
    f.session.voiceOnsetAt = 50;
    const speaking = f.hub.speak('s', 'Pending answer.', { questionId: 3, playbackId: 4 });
    f.setNow(200);
    assert.equal(f.hub.interruptSpeech('s', 'voice'), true);
    await assert.rejects(speaking, /interrupted/);
    assert.deepEqual(f.interrupts, [{ questionId: 3, playbackId: 4, cause: 'voice', playedMs: 0, latencyMs: 150 }]);
  } finally { f.hub.close(); }
});

test('closing a session while connecting rejects speech and cannot emit it later', async () => {
  const f = fixture();
  const pending = f.hub.speak('s', 'Never play.');
  const rejected = assert.rejects(pending, /closed/);
  f.hub.closeSession('s'); await rejected;
  f.sockets[0]!.open(); await tick();
  assert.equal(f.sockets[0]!.sent.some(text => text.includes('Never play')), false);
  f.hub.close();
});

test('first PCM and terminal event preserve playback owner and include handshake in TTFA', async () => {
  const f = fixture();
  try {
    const speaking = f.hub.speak('s', 'Answer.', { questionId: 7, playbackId: 12 });
    const rejected = assert.rejects(speaking, /interrupted/);
    f.setNow(200); f.sockets[0]!.open(); await tick();
    f.setNow(350); f.sockets[0]!.emit('message', Buffer.alloc(3200, 1), true);
    await tick();
    assert.deepEqual(f.starts, [{ questionId: 7, playbackId: 12, ttfaMs: 250 }]);
    f.hub.interruptSpeech('s'); await rejected;
    assert.equal((f.ends[0] as { playbackId: number }).playbackId, 12);
  } finally { f.hub.close(); }
});

test('a late close from the replaced meeting socket cannot cancel the new connection speech', async () => {
  const sockets: Socket[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test', deepgramApiKey: 'test', onTranscript: () => {},
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket; } });
  hub.register('s'); hub.bindBot('s', 'bot_test');
  const server = createServer();
  server.on('upgrade', (request, socket, head) => hub.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test', 's'));
  url.protocol = 'ws:'; url.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: WebSocket[] = [];
  try {
    const first = new WebSocket(url); clients.push(first); await once(first, 'open');
    const session = (hub as unknown as { sessions: Map<string, { attendeeSocket: WebSocket }> }).sessions.get('s')!;
    const replacedSocket = session.attendeeSocket;
    const next = new WebSocket(url); clients.push(next); await once(next, 'open');
    const speaking = hub.speak('s', 'New connection answer.');
    const rejected = assert.rejects(speaking, /interrupted/);
    await tick();
    replacedSocket.emit('close');
    assert.equal(sockets.at(-1)!.readyState, WebSocket.OPEN);
    assert.equal(hub.interruptSpeech('s'), true);
    await rejected;
  } finally {
    for (const client of clients) client.terminate();
    hub.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
