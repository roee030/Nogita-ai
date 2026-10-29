import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, chooseSttMode, createAttendeeAudioSocketUrl, finalConfidence, parseLanguages } from '../src/app/attendee-realtime-audio.ts';
import { PresenceHub } from '../src/app/presence.ts';
import { TurnLog, parseTurnLogMode } from '../src/app/turn-log.ts';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import { SpeechInterruptedError } from '../src/core/contracts.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';

test('Flux is refused while Hebrew is a meeting language; Nova-3 multilingual keeps Hebrew', () => {
  assert.deepEqual(chooseSttMode(undefined, ['en', 'he']), { mode: 'nova3-multilingual' });
  assert.equal(chooseSttMode('flux-english', ['en', 'he']).mode, 'nova3-multilingual');
  assert.match(chooseSttMode('flux-english', ['en', 'he']).refused ?? '', /he/);
  assert.deepEqual(chooseSttMode('flux-english', ['en']), { mode: 'flux-english' });
  assert.deepEqual(parseLanguages(undefined), ['en', 'he']);
  assert.deepEqual(parseLanguages('en'), ['en']);
  assert.deepEqual(parseLanguages('en,hebrew'), ['en', 'he']);
  assert.equal(finalConfidence({ is_final: true, channel: { alternatives: [{ transcript: 'hi', confidence: 0.91 }] } }), 0.91);
  assert.equal(finalConfidence({ is_final: false, channel: { alternatives: [{ transcript: 'hi', confidence: 0.5 }] } }), undefined);
});

test('the Nova-3 socket asks for every configured language as a hint', async () => {
  const urls: string[] = [];
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio', signingSecret: 's',
    deepgramApiKey: 'k', languages: ['en', 'he', 'ar'], onTranscript: () => {},
    createWebSocket: url => { urls.push(url); return Object.assign(new EventEmitter(), { readyState: WebSocket.CONNECTING, send() {}, close() {} }) as unknown as WebSocket; } });
  hub.register('lang');
  hub.bindBot('lang', 'bot_lang');
  (hub as unknown as { processAttendeeFrame: (id: string, s: unknown, p: unknown) => void }).processAttendeeFrame('lang',
    (hub as unknown as { sessions: Map<string, unknown> }).sessions.get('lang'), { bot_id: 'bot_lang',
      trigger: 'realtime_audio.per_participant', data: { participant_uuid: 'p1', sample_rate: 16000, chunk: Buffer.alloc(320).toString('base64') } });
  hub.close();
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.deepEqual(url.searchParams.getAll('language_hint'), ['en', 'he', 'ar']);
});

test('an interrupted turn reports how much played; speech start, end and the interruption are signalled', async () => {
  class FakeTts extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send(): void {}
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const server = createServer();
  const sockets: FakeTts[] = [];
  const events: string[] = [];
  let ended: { outcome: string; playedMs: number } | undefined;
  const hub = new AttendeeRealtimeAudioHub({ baseUrl: 'wss://nogita.example/webhooks/attendee/audio',
    signingSecret: 'test-secret', deepgramApiKey: 'test-key', onTranscript: () => {},
    onSpeechStart: () => events.push('start'),
    onSpeechEnd: (_s, end) => { events.push(`end:${end.outcome}`); ended = end; },
    onInterrupt: (_s, interrupt) => events.push(`interrupt:${interrupt.cause}`),
    createWebSocket: () => {
      const socket = new FakeTts();
      sockets.push(socket);
      queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket as unknown as WebSocket;
    } });
  hub.register('played');
  hub.bindBot('played', 'bot_played');
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const signed = new URL(createAttendeeAudioSocketUrl('wss://nogita.example/webhooks/attendee/audio', 'test-secret', 'played'));
  signed.protocol = 'ws:';
  signed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new WebSocket(signed);
  await once(client, 'open');
  const speaking = hub.speak('played', 'One. Two. Three. Four.');
  const outcome = speaking.then(() => undefined, (error: unknown) => error);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    // One second of audio, paced at playback speed; cut off after about a quarter of it.
    sockets[0]!.emit('message', Buffer.alloc(32_000, 1), true);
    sockets[0]!.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    assert.equal(hub.interruptSpeech('played'), true);
    const error = await outcome;
    assert.ok(error instanceof SpeechInterruptedError);
    assert.ok(error.playedMs! >= 150 && error.playedMs! <= 450, String(error.playedMs));
    assert.deepEqual(events, ['start', 'interrupt:command', 'end:interrupted']);
    assert.equal(ended?.playedMs, error.playedMs);
    assert.equal(hub.interruptSpeech('played'), false);
  } finally {
    client.terminate(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('the presence page key survives a restart; a stopped answer ends the speaking look at once', () => {
  let now = 1_000;
  const a = new PresenceHub({ keySecret: 'secret', now: () => now, schedule: () => 0, cancel: () => undefined });
  const b = new PresenceHub({ keySecret: 'secret', now: () => now, schedule: () => 0, cancel: () => undefined });
  assert.equal(a.open('meeting-1'), b.open('meeting-1'));
  assert.notEqual(a.open('meeting-2'), a.open('meeting-1'));
  assert.notEqual(new PresenceHub({ keySecret: 'other' }).open('meeting-1'), a.open('meeting-1'));
  a.outputAudio('meeting-1', Buffer.alloc(32_000 * 3));
  assert.equal(a.snapshotFor('meeting-1')?.state, 'speaking');
  now += 100;
  a.speechEnded('meeting-1');
  assert.equal(a.snapshotFor('meeting-1')?.state, 'idle');
});

test('a question that stops reporting leaves the screen instead of showing "thinking" forever', () => {
  let now = 0;
  const stale: number[] = [];
  const states: string[] = [];
  const hub = new PresenceHub({ now: () => now, schedule: () => 0, cancel: () => undefined,
    onStale: (_s, id) => stale.push(id), onState: (_s, snapshot) => states.push(snapshot.state) });
  hub.open('m');
  hub.question('m', { id: 7, status: 'working', request: 'what is open' });
  assert.equal(hub.snapshotFor('m')?.state, 'thinking');
  now = 119_000;
  hub.waiting('m', true);
  assert.equal(hub.snapshotFor('m')?.state, 'thinking');
  now = 121_000;
  hub.waiting('m', false);
  assert.equal(hub.snapshotFor('m')?.state, 'idle');
  assert.deepEqual(stale, [7]);
  assert.equal(states.at(-1), 'idle');
});

test('the turn log keeps no words or names unless full mode is chosen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-turns-'));
  try {
    assert.equal(parseTurnLogMode(undefined), 'redacted');
    const redacted = new TurnLog(directory, 'redacted', 'k', () => 5);
    redacted.record('session-1', { type: 'heard', speaker: redacted.person('Roee Angel'), addressed: true, verified: true,
      words: 4, confidence: 0.9, text: 'Nogita what is open' });
    redacted.record('session-1', { type: 'question', id: 1, status: 'chat_only', speaker: redacted.person('Roee Angel'),
      detail: 'cut off twice; the rest is in chat', request: 'what is open' });
    await redacted.flush();
    const [file] = await readdir(join(directory, 'turns'));
    const lines = (await readFile(join(directory, 'turns', file!), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.text, undefined);
    assert.equal(lines[1]!.request, undefined);
    assert.equal(lines[1]!.detail, 'cut off twice; the rest is in chat');
    assert.match(String(lines[0]!.speaker), /^p_[0-9a-f]{10}$/);
    assert.ok(!JSON.stringify(lines).includes('Roee'));
    const full = new TurnLog(directory, 'full', 'k');
    assert.equal(full.person('Roee Angel'), 'Roee Angel');
    const off = new TurnLog(directory, 'off', 'k');
    off.record('session-2', { type: 'session', phase: 'start' });
    await off.flush();
    assert.equal((await readdir(join(directory, 'turns'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a complete request to Nogita is not held for the long quiet window', async () => {
  const delays: number[] = [];
  const router = new AttendeeCommandRouter(async () => {}, async () => {},
    { chatAck: false, schedule: (_work, delayMs) => { delays.push(delayMs); return 0; }, cancel: () => undefined });
  router.beginSession('s');
  const actor = { id: 'roee', displayName: 'Roee', verified: true };
  const say = (text: string, id: string) => void router.accept({ sessionId: 's', botId: 'bot_x', speakerUuid: `p-${id}`,
    utterance: { eventId: id, actor, text } });
  say('Nogita, show me the open tasks.', '1');
  say('Nogita, can you check', '2');
  say('Nogita, what is open?', '3');
  say('We should ship on Monday.', '4');
  assert.deepEqual(delays, [300, 1200, 300, 1200]);
});

test('a private card is not put on the shared screen while an unverified guest can see it', async () => {
  const board = Object.assign(new DemoBoard(), {
    searchTasks: async () => [{ key: "KAN-1", title: "Login bug", status: "Open", url: "https://jira.example/KAN-1" }] });
  const shown: unknown[] = [];
  const context = (unverified: number | undefined) => buildToolbox({
    actor: { id: 'roee', displayName: 'Roee', verified: true }, request: 'show KAN-1', sessionId: 's', eventId: 'e',
    policy: { mayReadCode: () => true, mayWriteTask: () => false, mayDraftPR: () => false },
    code: new DemoCode(), board, completed: new Map(), onReceipt: async () => {},
    show: card => shown.push(card), screenAudience: () => unverified === undefined ? undefined : { unverified },
  }).toolbox;
  const guarded = await context(1).run('show_on_screen', { what: 'tasks', text: 'login' });
  assert.equal(guarded.isError, true);
  assert.match(guarded.content, /not a verified team member/);
  assert.equal(shown.length, 0);
  // Clearing the screen is always allowed.
  await context(1).run('show_on_screen', { what: 'nothing' });
  assert.deepEqual(shown, [undefined]);
});

test('the release report measures from the logs: first sound, interruptions, missed questions, stale speech', async () => {
  const { analyse, render } = await import('../tools/turn-report.ts');
  const log = [
    { at: 0, type: 'heard', speaker: 'p_a', addressed: true, verified: true, words: 5 },
    { at: 300, type: 'question', id: 1, status: 'working', speaker: 'p_a' },
    { at: 900, type: 'speech', id: 1, phase: 'start' },
    { at: 1_100, type: 'audio', phase: 'start' },
    { at: 2_000, type: 'interrupt', cause: 'voice', latencyMs: 180, playedMs: 900 },
    { at: 2_000, type: 'audio', phase: 'end', outcome: 'interrupted', playedMs: 900 },
    { at: 2_000, type: 'speech', id: 1, phase: 'end', outcome: 'interrupted' },
    { at: 2_100, type: 'question', id: 1, status: 'stopped', speaker: 'p_a' },
    { at: 2_500, type: 'speech', id: 1, phase: 'start' },
    { at: 3_000, type: 'turn', speaker: 'p_b', addressed: true, words: 6, result: 'ignored', ms: 5 },
    { at: 4_000, type: 'turn', speaker: 'p_a', addressed: false, words: 4, result: 'answered', ms: 900 },
    { at: 5_000, type: 'question', id: 2, status: 'working', speaker: 'p_b' },
  ];
  const report = analyse('m', log);
  assert.deepEqual(report.firstAudioMs, [1_100]);
  assert.deepEqual(report.interruptMs, [180]);
  assert.equal(report.staleSpeech, 1);
  assert.equal(report.unnamedActivations.length, 1);
  assert.deepEqual(report.missed.map(m => m.why), ['addressed by name but ignored', 'question never reached a final status']);
  const text = render([report]);
  assert.match(text, /First audible response p50 .* 1\.10 s \(n=1\) \| ≤ 1\.0 s \| \*\*misses\*\*/);
  assert.match(text, /Speech for a stopped\/cancelled question \| 1 /);
});
