import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Utterance } from '../core/contracts.ts';
import type { IdentityDirectory } from '../core/identity.ts';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((out, key) => {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
      return out;
    }, {});
  }
  return value;
}

export function canonicalJson(payload: unknown): string {
  return JSON.stringify(sortKeys(payload));
}

export function verifyAttendeeWebhookSignature(secretB64: string, payload: unknown, supplied: string | undefined): boolean {
  if (!secretB64 || !supplied) return false;
  let secret: Buffer;
  try { secret = Buffer.from(secretB64, 'base64'); } catch { return false; }
  if (!secret.length) return false;
  const expected = createHmac('sha256', secret).update(canonicalJson(payload), 'utf8').digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AttendeeTranscriptRequest {
  sessionId: string;
  botId: string;
  speakerUuid: string;
  attendeeUserUuid?: string;
  utterance: Utterance;
}

export interface AttendeeEnvelope {
  eventId: string;
  botId: string;
  sessionId: string;
}

export interface AttendeeParticipantEvent extends AttendeeEnvelope {
  participantUuid: string;
  attendeeUserUuid?: string;
  displayName?: string;
  eventType: 'join' | 'leave';
}

export interface AttendeeBotLogEvent {
  sessionId: string;
  botId: string;
  level: 'error';
}

export type AttendeeLifecycleEvent =
  | { kind: 'ended'; sessionId: string; botId: string; eventType: string }
  | { kind: 'fatal'; sessionId: string; botId: string; eventType: string };

export function parseAttendeeBotLog(payload: unknown): AttendeeBotLogEvent | null {
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.trigger !== 'bot_logs.update' || !root.data || typeof root.data !== 'object') return null;
  const data = root.data as Record<string, unknown>;
  return data.level === 'error' ? { sessionId: envelope.sessionId, botId: envelope.botId, level: 'error' } : null;
}

export function parseAttendeeLifecycleEvent(payload: unknown): AttendeeLifecycleEvent | null {
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.trigger !== 'bot.state_change' || !root.data || typeof root.data !== 'object') return null;
  const data = root.data as Record<string, unknown>;
  const newState = typeof data.new_state === 'string' ? data.new_state : '';
  const eventType = typeof data.event_type === 'string' ? data.event_type : '';
  if (newState === 'fatal_error' || eventType === 'fatal_error') {
    return { kind: 'fatal', sessionId: envelope.sessionId, botId: envelope.botId, eventType: 'fatal_error' };
  }
  if (eventType === 'meeting_ended' || eventType === 'post_processing_completed' || newState === 'ended') {
    return { kind: 'ended', sessionId: envelope.sessionId, botId: envelope.botId,
      eventType: eventType || 'ended' };
  }
  return null;
}

export function parseAttendeeParticipantEvent(payload: unknown): AttendeeParticipantEvent | null {
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.trigger !== 'participant_events.join_leave' || !root.data || typeof root.data !== 'object') return null;
  const data = root.data as Record<string, unknown>;
  const participantUuid = typeof data.participant_uuid === 'string' ? data.participant_uuid : '';
  const eventType = data.event_type;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(participantUuid) || (eventType !== 'join' && eventType !== 'leave')) return null;
  const attendeeUserUuid = typeof data.participant_user_uuid === 'string' && data.participant_user_uuid.length <= 128
    ? data.participant_user_uuid : undefined;
  const displayName = typeof data.participant_name === 'string' && data.participant_name.length <= 200
    ? data.participant_name : undefined;
  return { ...envelope, participantUuid, ...(attendeeUserUuid ? { attendeeUserUuid } : {}),
    ...(displayName ? { displayName } : {}), eventType };
}

export function parseAttendeeEnvelope(payload: unknown): AttendeeEnvelope | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const metadata = root.bot_metadata;
  if (typeof root.idempotency_key !== 'string' || !root.idempotency_key ||
      typeof root.bot_id !== 'string' || !root.bot_id ||
      !metadata || typeof metadata !== 'object') return null;
  const sessionId = (metadata as Record<string, unknown>).session_id;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100) return null;
  return { eventId: root.idempotency_key, botId: root.bot_id, sessionId };
}

export function parseAttendeeTranscript(payload: unknown, identities: IdentityDirectory): AttendeeTranscriptRequest | null {
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.trigger !== 'transcript.update' || !root.data || typeof root.data !== 'object') return null;
  const data = root.data as Record<string, unknown>;
  const transcription = data.transcription as Record<string, unknown> | undefined;
  const text = typeof transcription?.transcript === 'string' ? transcription.transcript.trim() : '';
  const userUuid = typeof data.speaker_user_uuid === 'string' ? data.speaker_user_uuid : '';
  const speakerUuid = typeof data.speaker_uuid === 'string' ? data.speaker_uuid : '';
  if (!text || text.length > 4000 || (!userUuid && !speakerUuid)) return null;
  const identity = userUuid ? identities.fromAttendee(userUuid) : undefined;
  const displayName = identity?.displayName ?? (typeof data.speaker_name === 'string' ? data.speaker_name : 'Meeting participant');
  return {
    sessionId: envelope.sessionId,
    botId: envelope.botId,
    speakerUuid,
    ...(userUuid ? { attendeeUserUuid: userUuid } : {}),
    utterance: {
      eventId: envelope.eventId,
      actor: identity
        ? { id: identity.id, displayName, verified: true }
        : { id: `unmapped:attendee:${userUuid || speakerUuid}`, displayName, verified: false },
      text,
      at: typeof data.timestamp_ms === 'number' ? data.timestamp_ms : undefined,
    },
  };
}

export function parseAttendeeEndedSession(payload: unknown): string | null {
  const event = parseAttendeeLifecycleEvent(payload);
  return event?.kind === 'ended' ? event.sessionId : null;
}
