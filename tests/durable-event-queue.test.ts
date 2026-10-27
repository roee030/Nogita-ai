import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedFileEventQueue } from '../src/app/durable-event-queue.ts';
import { EventWorker } from '../src/app/event-worker.ts';

const key = randomBytes(32).toString('base64');

test('queued provider payload is encrypted at rest and survives a new queue instance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = '{"text":"Nogita create the private task","event_id":"Ev-private"}';
  const first = new EncryptedFileEventQueue(root, key);
  assert.equal(await first.enqueue('slack', 'Ev-private', payload), 'queued');

  const files = await readdir(join(root, 'event-queue'));
  assert.equal(files.length, 1);
  const disk = await readFile(join(root, 'event-queue', files[0]!), 'utf8');
  assert.doesNotMatch(disk, /Nogita|private task|Ev-private/);
  assert.doesNotMatch(files[0]!, /Ev-private/);

  const claim = await new EncryptedFileEventQueue(root, key).claimNext();
  assert.equal(claim?.item.namespace, 'slack');
  assert.equal(claim?.item.payload, payload);
  await claim?.complete();
  assert.equal(await new EncryptedFileEventQueue(root, key).claimNext(), null);
});

test('duplicate enqueue is suppressed and two workers cannot claim one event', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key);
  assert.equal(await queue.enqueue('attendee', 'same-event', '{}'), 'queued');
  assert.equal(await queue.enqueue('attendee', 'same-event', '{}'), 'duplicate');
  const [one, two] = await Promise.all([queue.claimNext(), new EncryptedFileEventQueue(root, key).claimNext()]);
  assert.equal([one, two].filter(Boolean).length, 1);
  await (one ?? two)?.complete();
});

test('failed work is retried and stale leases recover after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key, { leaseMs: 20 });
  await queue.enqueue('slack', 'retry-event', '{"retry":true}');
  const first = await queue.claimNext();
  assert.ok(first);
  await first.retry();
  const second = await queue.claimNext();
  assert.equal(second?.item.attempts, 1);
  const leaseName = (await readdir(join(root, 'event-queue'))).find(name => name.endsWith('.lease'))!;
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, 'event-queue', leaseName), old, old);
  const recovered = await new EncryptedFileEventQueue(root, key, { leaseMs: 20 }).claimNext();
  assert.equal(recovered?.item.payload, '{"retry":true}');
  await recovered?.complete();
});

test('tampered ciphertext is rejected without exposing its contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key);
  await queue.enqueue('slack', 'tampered', '{"secret":"not-for-logs"}');
  const directory = join(root, 'event-queue');
  const name = (await readdir(directory))[0]!;
  const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, string>;
  record.ciphertext = record.ciphertext!.slice(0, -2) + 'AA';
  await import('node:fs/promises').then(fs => fs.writeFile(join(directory, name), JSON.stringify(record)));
  await assert.rejects(() => queue.claimNext(), error => {
    assert.match(String(error), /authentication failed/);
    assert.doesNotMatch(String(error), /not-for-logs/);
    return true;
  });
});

test('completed marker retention is bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key, { maxCompleted: 2 });
  for (const id of ['one', 'two', 'three']) {
    await queue.enqueue('slack', id, '{}');
    await (await queue.claimNext())?.complete();
  }
  const done = (await readdir(join(root, 'event-queue'))).filter(name => name.endsWith('.done'));
  assert.ok(done.length <= 2);
});

test('dead-letter retention is bounded after repeated authenticated-record failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key, { maxCompleted: 2 });
  const directory = join(root, 'event-queue');
  for (const id of ['bad-one', 'bad-two', 'bad-three']) {
    await queue.enqueue('slack', id, '{"private":"value"}');
    const name = (await readdir(directory)).find(entry => entry.endsWith('.record'))!;
    const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, string>;
    record.tag = 'AAAAAAAAAAAAAAAAAAAAAA==';
    await import('node:fs/promises').then(fs => fs.writeFile(join(directory, name), JSON.stringify(record)));
    await assert.rejects(() => queue.claimNext(), /authentication failed/);
  }
  await queue.enqueue('slack', 'prune-trigger', '{}');
  assert.ok((await readdir(directory)).filter(name => name.endsWith('.dead')).length <= 2);
});

test('worker retries failed processing and completes it on the next pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new EncryptedFileEventQueue(root, key);
  await queue.enqueue('slack', 'worker-event', '{"ok":true}');
  let calls = 0;
  const worker = new EventWorker(queue, async item => {
    calls++;
    assert.equal(item.payload, '{"ok":true}');
    if (calls === 1) throw new Error('temporary');
  });
  assert.equal(await worker.processOnce(), 'retried');
  assert.equal(await worker.processOnce(), 'completed');
  assert.equal(await worker.processOnce(), 'empty');
});
