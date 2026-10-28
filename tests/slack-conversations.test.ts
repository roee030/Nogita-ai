import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackConversationRegistry } from '../src/app/slack-conversations.ts';

test('Slack conversations refresh activity and do not expire while a command is in flight', () => {
  let now = 10_000;
  const registry = new SlackConversationRegistry(2, 100, () => now);
  const first = registry.enter('first');
  now += 101;
  assert.deepEqual(registry.cleanupCandidates(), []);
  first.release();
  now += 100;
  assert.deepEqual(registry.cleanupCandidates(), ['first']);
});

test('Slack conversation cleanup frees the oldest idle slots without selecting active work', () => {
  let now = 1_000;
  const registry = new SlackConversationRegistry(2, 10_000, () => now);
  const old = registry.enter('old'); old.release();
  now++;
  const protectedSession = registry.enter('busy');
  now++;
  const newest = registry.enter('newest'); newest.release();

  assert.deepEqual(registry.cleanupCandidates(now), ['old']);
  registry.forget('old');
  assert.equal(registry.size, 2);
  protectedSession.release();
});

test('releasing a conversation lease is idempotent and allows cleanup', () => {
  let now = 0;
  const registry = new SlackConversationRegistry(3, 5, () => now);
  const lease = registry.enter('thread');
  lease.release();
  lease.release();
  now = 5;
  assert.deepEqual(registry.cleanupCandidates(), ['thread']);
  assert.equal(registry.forget('thread'), true);
  assert.equal(registry.forget('thread'), false);
});
