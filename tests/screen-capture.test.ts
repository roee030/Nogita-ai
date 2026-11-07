import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { sampleFrames } from '../tools/screen-spike/run.ts';
import { ScreenCaptureHub, parseScreenResolution, screenChanged, screenWebsocketSettings } from '../src/app/screen-capture.ts';

test('a still screen is not kept; a size change or 30 seconds is', () => {
  assert.equal(screenChanged(100_000, undefined, 0), true, 'the first frame');
  assert.equal(screenChanged(100_500, 100_000, 1_000), false, 're-encoding noise');
  assert.equal(screenChanged(110_000, 100_000, 1_000), true, 'the slide changed');
  assert.equal(screenChanged(100_100, 100_000, 30_000), true, 'a change that keeps the size is caught within 30 s');
});

test('settings ask for the screen only, and the flag takes 720p or 1080p', () => {
  assert.deepEqual(screenWebsocketSettings('wss://x/y', '720p'), { url: 'wss://x/y', webcam_resolution: 'none', screenshare_resolution: '720p' });
  assert.equal(parseScreenResolution(''), undefined);
  assert.equal(parseScreenResolution('1080p'), '1080p');
  assert.throws(() => parseScreenResolution('4k'), /720p or 1080p/);
});

async function connected(hub: ScreenCaptureHub, sessionId: string, tamper = false) {
  const server = createServer();
  server.on('upgrade', (request, socket, head) => { hub.handleUpgrade(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(hub.register(sessionId));
  url.protocol = 'ws:';
  url.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (tamper) url.searchParams.set('signature', 'x'.repeat(43));
  const client = new WebSocket(url);
  const close = async () => { client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { client, close };
}
const frame = (bytes: number, source = 'screenshare', format = 'jpeg') => JSON.stringify({ bot_id: 'b', trigger: 'realtime_video.per_participant',
  data: { participant_uuid: 'p', frame: Buffer.alloc(bytes, 7).toString('base64'), format, source } });

test('keeps changed screenshare frames only, reports them, and wipes them when the session ends', async () => {
  let now = 1_000;
  const hub = new ScreenCaptureHub('wss://nogita.example', 'secret', () => now);
  const { client, close } = await connected(hub, 's');
  await once(client, 'open');
  try {
    client.send(frame(100_000));
    client.send(frame(100_100));                 // same screen
    client.send(frame(120_000));                 // changed
    client.send(frame(120_000, 'webcam'));       // not the screen
    client.send(frame(120_000, 'screenshare', 'png'));
    client.send('not json');
    now += 500;
    await new Promise(resolve => setTimeout(resolve, 60));
    const report = hub.report('s')!;
    assert.equal(report.stats.received, 3);
    assert.equal(report.stats.kept, 2);
    assert.deepEqual(report.frames.map(item => item.bytes), [100_000, 120_000]);
    assert.equal(hub.frame('s', 2)!.length, 120_000);
    hub.closeSession('s');
    assert.equal(hub.report('s'), undefined);
    assert.equal(hub.frame('s', 2), undefined);
  } finally { await close(); }
});

test('a wrong signature, or a session it does not know, is refused', async () => {
  const hub = new ScreenCaptureHub('wss://nogita.example', 'secret');
  const { client, close } = await connected(hub, 's', true);
  const [error] = await once(client, 'error') as [Error];
  assert.match(error.message, /401/);
  await close();
  assert.throws(() => new ScreenCaptureHub('https://nogita.example', 'secret'), /WSS/);
});

function frameMessage(bytes: number): string {
  return JSON.stringify({ trigger: 'realtime_video.per_participant', data: { source: 'screenshare', format: 'jpeg', frame: Buffer.alloc(bytes, 1).toString('base64') } });
}
function deliver(hub: ScreenCaptureHub, sessionId: string, sizes: number[]): void {
  const capture = (hub as unknown as { captures: Map<string, unknown>; onMessage(capture: unknown, data: Buffer): void });
  for (const size of sizes) capture.onMessage(capture.captures.get(sessionId), Buffer.from(frameMessage(size)));
}

test('keep all: a still screen is kept too, and each frame says what the size rule would have done', () => {
  let now = 1_000;
  const hub = new ScreenCaptureHub('wss://nogita.example', 'secret', () => now++, { keepAll: true });
  hub.register('s');
  deliver(hub, 's', [1_000, 1_000, 1_000, 2_000]);
  const report = hub.report('s')!;
  assert.deepEqual(report.frames.map(frame => frame.sizeRule), [true, false, false, true]);
  assert.equal(report.stats.kept, 4);
  assert.equal(report.stats.keptBySizeRule, 2);
});

test('the default still drops a still screen', () => {
  const hub = new ScreenCaptureHub('wss://nogita.example', 'secret', () => 1_000);
  hub.register('s');
  deliver(hub, 's', [1_000, 1_000, 1_000]);
  assert.equal(hub.report('s')!.frames.length, 1);
});

test('memory stays bounded in bytes: the oldest frames go, are counted, and the session end wipes the rest', () => {
  const hub = new ScreenCaptureHub('wss://nogita.example', 'secret', () => 1_000, { keepAll: true, maxHeldBytes: 2_500 });
  hub.register('s');
  deliver(hub, 's', [1_000, 1_000, 1_000, 1_000]);
  const report = hub.report('s')!;
  assert.deepEqual(report.frames.map(frame => frame.n), [3, 4]);
  assert.equal(report.stats.evicted, 2);
  assert.equal(hub.frame('s', 1), undefined);
  hub.closeSession('s');
  assert.equal(hub.report('s'), undefined);
});

test('the read is a bounded, evenly spaced sample with both ends', () => {
  const frames = Array.from({ length: 600 }, (_, i) => i);
  const sample = sampleFrames(frames, 20);
  assert.equal(sample.length, 20);
  assert.equal(sample[0], 0);
  assert.equal(sample.at(-1), 599);
  assert.equal(new Set(sample).size, 20);
  assert.deepEqual(sampleFrames([1, 2], 20), [1, 2]);
  assert.deepEqual(sampleFrames(frames, 0), []);
});
