import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyBeforeCleanup } from '../src/app/attendee-lifecycle.ts';

test('provider exit cleanup proceeds when the final meeting-chat notice fails', async () => {
  const events: string[] = [];
  await notifyBeforeCleanup(
    async () => { events.push('notice'); throw new Error('provider details must not escape'); },
    async () => { events.push('cleanup'); },
    () => { events.push('safe-failure-marker'); },
  );
  assert.deepEqual(events, ['notice', 'safe-failure-marker', 'cleanup']);
});

test('provider exit cleanup does not wait indefinitely for a stuck chat endpoint', async () => {
  const startedAt = Date.now();
  let cleaned = false;
  await notifyBeforeCleanup(() => new Promise<void>(() => {}), async () => { cleaned = true; }, () => {}, 5);
  assert.equal(cleaned, true);
  assert.ok(Date.now() - startedAt < 250);
});
