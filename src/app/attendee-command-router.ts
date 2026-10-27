import { createHash, randomInt } from 'node:crypto';
import type { Actor, Utterance } from '../core/contracts.ts';
import { directlyAddressesNogita } from '../core/policy.ts';
import type { AttendeeTranscriptRequest } from './attendee-webhook.ts';

type ScheduledWork = () => void | Promise<void>;
interface BufferEntry { actor: Actor; eventIds: string[]; fragments: string[]; at?: number; timer: unknown }
interface SessionState {
  owner?: Actor;
  challenge?: string;
  bindings: Map<string, Actor>;
  buffers: Map<string, BufferEntry>;
  acceptedEventIds: Set<string>;
}
export interface AttendeeCommandRouterOptions {
  quietMs?: number;
  randomCode?: () => string;
  schedule?: (work: ScheduledWork, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class AttendeeCommandRouter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly quietMs: number;
  private readonly randomCode: () => string;
  private readonly schedule: (work: ScheduledWork, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly emit: (sessionId: string, utterance: Utterance) => Promise<void>,
    private readonly sendStatus: (sessionId: string, message: string) => Promise<void>,
    options: AttendeeCommandRouterOptions = {},
  ) {
    this.quietMs = options.quietMs ?? 1200;
    this.randomCode = options.randomCode ?? (() => String(randomInt(100000, 1000000)));
    this.schedule = options.schedule ?? ((work, delayMs) => setTimeout(() => { void work(); }, delayMs));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => {});
  }

  beginSession(sessionId: string, owner?: Actor): string | undefined {
    this.endSession(sessionId);
    if (owner && !owner.verified) throw new Error('meeting owner must be verified');
    const challenge = owner ? `Nogita verify ${this.randomCode()}` : undefined;
    this.sessions.set(sessionId, {
      ...(owner ? { owner, challenge } : {}), bindings: new Map(), buffers: new Map(), acceptedEventIds: new Set(),
    });
    return challenge;
  }

  accept(request: AttendeeTranscriptRequest): void {
    const state = this.sessions.get(request.sessionId);
    if (!state || state.acceptedEventIds.has(request.utterance.eventId)) return;
    state.acceptedEventIds.add(request.utterance.eventId);
    if (state.acceptedEventIds.size > 2000) state.acceptedEventIds.delete(state.acceptedEventIds.values().next().value!);
    const previous = state.buffers.get(request.speakerUuid);
    if (previous) this.cancel(previous.timer);
    const fragments = [...(previous?.fragments ?? []), request.utterance.text.trim()].slice(-24);
    const eventIds = [...(previous?.eventIds ?? []), request.utterance.eventId].slice(-24);
    const actor = request.utterance.actor.verified ? request.utterance.actor : previous?.actor ?? request.utterance.actor;
    const at = previous?.at ?? request.utterance.at;
    const entry: BufferEntry = { actor, fragments, eventIds, ...(at === undefined ? {} : { at }), timer: undefined };
    entry.timer = this.schedule(() => this.flush(request.sessionId, request.speakerUuid).catch(this.onError), this.quietMs);
    state.buffers.set(request.speakerUuid, entry);
  }

  private async flush(sessionId: string, speakerUuid: string): Promise<void> {
    const state = this.sessions.get(sessionId); const entry = state?.buffers.get(speakerUuid);
    if (!state || !entry) return;
    state.buffers.delete(speakerUuid);
    const text = entry.fragments.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const bound = state.bindings.get(speakerUuid);
    const actor = bound ?? entry.actor;
    if (!actor.verified) {
      if (state.owner && state.challenge && normalized(text) === normalized(state.challenge)) {
        state.bindings.set(speakerUuid, state.owner);
        await this.sendStatus(sessionId, `Verified ${state.owner.displayName} for this meeting.`);
      } else if (directlyAddressesNogita(text)) {
        const guidance = state.challenge
          ? `I heard you, but I cannot verify this speaker. Please repeat: ${state.challenge}`
          : 'I heard you, but I cannot verify this speaker. Start the session with an authorized owner.';
        await this.sendStatus(sessionId, guidance);
      }
      return;
    }
    const eventId = `attendee-combined-${createHash('sha256').update(entry.eventIds.join('\0')).digest('hex')}`;
    await this.emit(sessionId, { eventId, actor, text, ...(entry.at === undefined ? {} : { at: entry.at }) });
  }

  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const entry of state.buffers.values()) this.cancel(entry.timer);
    state.buffers.clear(); state.bindings.clear(); state.acceptedEventIds.clear();
    this.sessions.delete(sessionId);
  }

  sessionCount(): number { return this.sessions.size; }
}
