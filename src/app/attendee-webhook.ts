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
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.trigger !== 'bot.state_change' || !root.data || typeof root.data !== 'object') return null;
  const data = root.data as Record<string, unknown>;
  const ended = data.event_type === 'meeting_ended' || data.event_type === 'post_processing_completed' || data.new_state === 'ended';
  return ended ? envelope.sessionId : null;
}
