import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionUsageRegistry } from '../src/app/session-usage.ts';

test('session usage estimates Attendee bot time and combines meeting-scoped AI usage', () => {
  let now = 1_000;
  const usage = new SessionUsageRegistry(0.50, () => now);
  usage.start('meeting-1', 'attendee');
  now += 10 * 60_000;
  usage.end('meeting-1');

  assert.deepEqual(usage.report('meeting-1', {
    model: 'claude-haiku-5-5', inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0.00015,
  }), {
    sessionId: 'meeting-1',
    provider: 'attendee',
    active: false,
    durationSeconds: 600,
    meetingEstimatedUsd: 0.083333,
    ai: { model: 'claude-haiku-5-5', inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0.00015 },
    totalEstimatedUsd: 0.083483,
  });
});

test('session usage distinguishes estimate from free credits and rejects unknown sessions', () => {
  const usage = new SessionUsageRegistry(0.50, () => 10_000);
  usage.start('demo-1', 'demo');
  const report = usage.report('demo-1');
  assert.ok(report);
  assert.equal(report.meetingEstimatedUsd, 0);
  assert.equal(report.totalEstimatedUsd, 0);
  assert.equal(usage.report('missing'), undefined);
});
