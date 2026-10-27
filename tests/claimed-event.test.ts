import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventLedger } from '../src/app/event-ledger.ts';
import { runClaimedEvent } from '../src/app/claimed-event.ts';

test('claimed event completes once and stays suppressed across ledger instances', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-claimed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  assert.equal(await runClaimedEvent(new FileEventLedger(root), 'slack', 'Ev-private', async () => { calls++; }), 'processed');
  assert.equal(await runClaimedEvent(new FileEventLedger(root), 'slack', 'Ev-private', async () => { calls++; }), 'completed');
  assert.equal(calls, 1);
});

test('claimed event suppresses a concurrent duplicate while work is active', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-claimed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileEventLedger(root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = runClaimedEvent(ledger, 'slack', 'Ev-concurrent', () => gate);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await runClaimedEvent(ledger, 'slack', 'Ev-concurrent', async () => assert.fail('duplicate ran')), 'active');
  release();
  assert.equal(await first, 'processed');
});

test('claimed event releases failed work so a later delivery can retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nogita-claimed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileEventLedger(root);
  await assert.rejects(() => runClaimedEvent(ledger, 'slack', 'Ev-retry', async () => { throw new Error('temporary'); }), /temporary/);
  assert.equal(await runClaimedEvent(ledger, 'slack', 'Ev-retry', async () => {}), 'processed');
});
