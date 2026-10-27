import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeEnrollmentCandidates } from '../src/app/attendee-enrollment.ts';

test('Attendee enrollment candidates are bounded, deduplicated, and contain only UUID metadata', () => {
  let now = 1_000;
  const candidates = new AttendeeEnrollmentCandidates({ maxCandidates: 2, retentionMs: 10_000, now: () => now });
  candidates.observe('user-one');
  now++;
  candidates.observe('user-one');
  candidates.observe('user-two');
  candidates.observe('user-three');

  assert.deepEqual(candidates.list(), [
    { attendeeUserUuid: 'user-three', observedAt: 1_001 },
    { attendeeUserUuid: 'user-two', observedAt: 1_001 },
  ]);
  assert.doesNotMatch(JSON.stringify(candidates.list()), /transcript|speakerName|meeting/);
});

test('Attendee enrollment candidates expire and invalid UUIDs are rejected', () => {
  let now = 1_000;
  const candidates = new AttendeeEnrollmentCandidates({ retentionMs: 100, now: () => now });
  candidates.observe('stable-user');
  now = 1_101;
  assert.deepEqual(candidates.list(), []);
  assert.throws(() => candidates.observe(''), /invalid Attendee user UUID/);
  assert.throws(() => candidates.observe('x'.repeat(501)), /invalid Attendee user UUID/);
});
