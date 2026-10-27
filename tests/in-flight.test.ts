import test from 'node:test';
import assert from 'node:assert/strict';
import { InFlightWork } from '../src/app/in-flight.ts';

test('in-flight tracker drains work that was accepted before shutdown', async () => {
  const tracker = new InFlightWork();
  let release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });

  tracker.track(work);
  assert.equal(tracker.size, 1);
  const draining = tracker.drain(200);
  await Promise.resolve();
  assert.equal(tracker.accepting, false);
  release();

  assert.equal(await draining, true);
  assert.equal(tracker.size, 0);
  assert.throws(() => tracker.track(Promise.resolve()), /shutting down/);
});

test('in-flight tracker observes failed work and still finishes draining', async () => {
  const tracker = new InFlightWork();
  tracker.track(Promise.reject(new Error('expected test failure')));

  assert.equal(await tracker.drain(200), true);
  assert.equal(tracker.size, 0);
});

test('in-flight tracker reports a bounded drain timeout', async () => {
  const tracker = new InFlightWork();
  let release!: () => void;
  tracker.track(new Promise<void>(resolve => { release = resolve; }));

  assert.equal(await tracker.drain(10), false);
  assert.equal(tracker.size, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tracker.size, 0);
});
