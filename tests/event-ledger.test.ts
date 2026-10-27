import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBindingRegistry, FileEventLedger } from '../src/app/event-ledger.ts';

test('event ledger atomically claims, completes, and survives a new process instance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new FileEventLedger(root);
  const begun = await first.begin('attendee', 'private-provider-event-id');
  assert.equal(begun.status, 'started');
  if (begun.status !== 'started') throw new Error('expected started claim');
  assert.equal((await first.begin('attendee', 'private-provider-event-id')).status, 'active');
  await begun.claim!.complete();
  assert.equal((await new FileEventLedger(root).begin('attendee', 'private-provider-event-id')).status, 'completed');

  const files = await readdir(join(root, 'attendee'));
  assert.equal(files.some(name => name.includes('private-provider-event-id')), false);
  assert.equal(await readFile(join(root, 'attendee', files[0]!), 'utf8'), '');
});

test('failed work releases its claim and stale claims can be recovered', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileEventLedger(root, { leaseMs: 20 });
  const failed = await ledger.begin('attendee', 'retry-me');
  if (failed.status !== 'started') throw new Error('expected started claim');
  await failed.claim!.abandon();
  const retried = await ledger.begin('attendee', 'retry-me');
  assert.equal(retried.status, 'started');
  if (retried.status !== 'started') throw new Error('expected retry claim');
  await retried.claim!.abandon();

  const stale = await ledger.begin('attendee', 'stale-event');
  assert.equal(stale.status, 'started');
  const pending = (await readdir(join(root, 'attendee'))).find(name => name.endsWith('.pending') && name !== undefined)!;
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, 'attendee', pending), old, old);
  assert.equal((await ledger.begin('attendee', 'stale-event')).status, 'started');
});

test('completed ledger retention is bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileEventLedger(root, { maxCompleted: 2 });
  for (const id of ['one', 'two', 'three']) {
    const result = await ledger.begin('attendee', id);
    if (result.status !== 'started') throw new Error('expected started claim');
    await result.claim!.complete();
  }
  const completed = (await readdir(join(root, 'attendee'))).filter(name => name.endsWith('.done'));
  assert.ok(completed.length <= 2);
});

test('binding registry survives restart without storing session or bot IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-bindings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileBindingRegistry(root);
  await registry.register('private-session', 'bot_private123');
  assert.equal(await new FileBindingRegistry(root).has('private-session', 'bot_private123'), true);
  assert.equal(await registry.has('private-session', 'bot_other'), false);

  const files = await readdir(join(root, 'attendee-bindings'));
  assert.equal(files.length, 1);
  assert.doesNotMatch(files[0]!, /private-session|bot_private123/);
  assert.equal(await readFile(join(root, 'attendee-bindings', files[0]!), 'utf8'), '');

  await registry.remove('private-session', 'bot_private123');
  assert.equal(await registry.has('private-session', 'bot_private123'), false);
});

test('orphaned pending claims are eventually pruned', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileEventLedger(root, { orphanRetentionMs: 20 });
  const orphan = await ledger.begin('attendee', 'orphan');
  assert.equal(orphan.status, 'started');
  const directory = join(root, 'attendee');
  const pending = (await readdir(directory)).find(name => name.endsWith('.pending'))!;
  const old = new Date(Date.now() - 60_000);
  await utimes(join(directory, pending), old, old);

  await ledger.begin('attendee', 'new-event');
  assert.equal((await readdir(directory)).includes(pending), false);
});
