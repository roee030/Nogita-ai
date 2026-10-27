import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { IdentityDirectory } from '../src/core/identity.ts';
import { canonicalJson, parseAttendeeEndedSession, parseAttendeeEnvelope, parseAttendeeTranscript, verifyAttendeeWebhookSignature } from '../src/app/attendee-webhook.ts';

const secret = Buffer.from('webhook-secret').toString('base64');
const transcriptPayload = {
  trigger: 'transcript.update',
  bot_id: 'bot_123',
  idempotency_key: '1f8e74ef-1d75-4e83-bfad-3bced67127ab',
  bot_metadata: { session_id: 'meeting-1' },
  data: {
    speaker_name: 'Roee Angel',
    speaker_uuid: 'participant-1',
    speaker_user_uuid: 'meet-roee',
    timestamp_ms: 1234,
    transcription: { transcript: 'Nogita, explain the authentication code' },
  },
};

test('Attendee signature uses canonical JSON and base64 HMAC-SHA256', () => {
  const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(canonicalJson(transcriptPayload), 'utf8').digest('base64');
  assert.equal(verifyAttendeeWebhookSignature(secret, transcriptPayload, signature), true);
  assert.equal(verifyAttendeeWebhookSignature(secret, { ...transcriptPayload, bot_id: 'tampered' }, signature), false);
});

test('Attendee transcript maps provider speaker to shared internal identity', () => {
  const identities = new IdentityDirectory([{
    id: 'roee', displayName: 'Roee Angel', attendeeUserUuid: 'meet-roee',
  }]);
  const parsed = parseAttendeeTranscript(transcriptPayload, identities);
  assert.equal(parsed?.sessionId, 'meeting-1');
  assert.equal(parsed?.utterance.eventId, transcriptPayload.idempotency_key);
  assert.deepEqual(parsed?.utterance.actor, { id: 'roee', displayName: 'Roee Angel', verified: true });
  assert.equal(parsed?.attendeeUserUuid, 'meet-roee');
  assert.equal(parsed?.utterance.text, 'Nogita, explain the authentication code');
});

test('Attendee envelope binds the delivery to both internal session and provider bot', () => {
  assert.deepEqual(parseAttendeeEnvelope(transcriptPayload), {
    eventId: transcriptPayload.idempotency_key,
    botId: 'bot_123',
    sessionId: 'meeting-1',
  });
  assert.equal(parseAttendeeEnvelope({ ...transcriptPayload, bot_id: '' }), null);
  assert.equal(parseAttendeeEnvelope({ ...transcriptPayload, bot_metadata: {} }), null);
});

test('unknown Attendee speaker remains unverified and malformed payloads are ignored', () => {
  const parsed = parseAttendeeTranscript(transcriptPayload, new IdentityDirectory([]));
  assert.equal(parsed?.utterance.actor.verified, false);
  assert.equal(parsed?.attendeeUserUuid, 'meet-roee');
  assert.equal(parseAttendeeTranscript({ ...transcriptPayload, trigger: 'bot.state_change' }, new IdentityDirectory([])), null);
  assert.equal(parseAttendeeTranscript({ ...transcriptPayload, bot_metadata: {} }, new IdentityDirectory([])), null);
});

test('Attendee meeting-ended state resolves the internal session', () => {
  const payload = {
    trigger: 'bot.state_change', idempotency_key: 'end-1', bot_id: 'bot_123',
    bot_metadata: { session_id: 'meeting-1' },
    data: { new_state: 'post_processing', event_type: 'meeting_ended' },
  };
  assert.equal(parseAttendeeEndedSession(payload), 'meeting-1');
  assert.equal(parseAttendeeEndedSession({ ...payload, data: { new_state: 'joined_recording' } }), null);
});
