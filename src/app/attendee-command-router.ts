import { createHash, randomInt } from 'node:crypto';
import { InvalidPlanningResponseError, type Actor, type Utterance } from '../core/contracts.ts';
import { directlyAddressesNogita, isExplicitLeaveRequest, removeAddress } from '../core/policy.ts';
import type { AttendeeTranscriptRequest } from './attendee-webhook.ts';

type ScheduledWork = () => void | Promise<void>;
interface Fragment { text: string; eventId: string; at?: number; sequence: number }
interface BufferEntry {
  actor: Actor; fragments: Fragment[]; timer: unknown;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}
interface SessionState {
  owner?: Actor;
  challenge?: string;
  bindings: Map<string, Actor>;
  buffers: Map<string, BufferEntry>;
  acceptedEventIds: Set<string>;
  notices: Set<string>;
}
export interface AttendeeCommandRouterOptions {
  quietMs?: number;
  randomCode?: () => string;
  schedule?: (work: ScheduledWork, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
  onLeave?: (sessionId: string) => Promise<void>;
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
  private readonly onLeave?: (sessionId: string) => Promise<void>;
  private sequence = 0;

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
    this.onLeave = options.onLeave;
  }

  beginSession(sessionId: string, owner?: Actor): string | undefined {
    this.endSession(sessionId);
    if (owner && !owner.verified) throw new Error('meeting owner must be verified');
    const challenge = owner ? `Nogita verify ${this.randomCode()}` : undefined;
    this.sessions.set(sessionId, {
      ...(owner ? { owner, challenge } : {}), bindings: new Map(), buffers: new Map(), acceptedEventIds: new Set(),
      notices: new Set(),
    });
    return challenge;
  }

  accept(request: AttendeeTranscriptRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId);
    if (!state || state.acceptedEventIds.has(request.utterance.eventId)) return Promise.resolve();
    state.acceptedEventIds.add(request.utterance.eventId);
    if (state.acceptedEventIds.size > 2000) state.acceptedEventIds.delete(state.acceptedEventIds.values().next().value!);
    const previous = state.buffers.get(request.speakerUuid);
    if (previous) this.cancel(previous.timer);
    const fragment: Fragment = { text: request.utterance.text.trim(), eventId: request.utterance.eventId,
      sequence: this.sequence++, ...(request.utterance.at === undefined ? {} : { at: request.utterance.at }) };
    const fragments = [...(previous?.fragments ?? []), fragment].slice(-24);
    const actor = request.utterance.actor.verified ? request.utterance.actor : previous?.actor ?? request.utterance.actor;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise; reject = rejectPromise;
    });
    completion.catch(() => undefined);
    const entry: BufferEntry = { actor, fragments, waiters: [...(previous?.waiters ?? []), { resolve, reject }], timer: undefined };
    entry.timer = this.schedule(() => this.flush(request.sessionId, request.speakerUuid).catch(this.onError), this.quietMs);
    state.buffers.set(request.speakerUuid, entry);
    return completion;
  }

  /** Treat provider-final speech as a fragment; a quiet window prevents interruptions at short pauses. */
  acceptFinal(request: AttendeeTranscriptRequest): Promise<void> {
    return this.accept(request);
  }

  /** Flux has already identified the end of the speaker's turn. */
  acceptCompletedTurn(request: AttendeeTranscriptRequest): Promise<void> {
    const state = this.sessions.get(request.sessionId);
    if (!state || state.acceptedEventIds.has(request.utterance.eventId)) return Promise.resolve();
    const completion = this.accept(request);
    const entry = state.buffers.get(request.speakerUuid);
    if (entry) {
      this.cancel(entry.timer);
      void this.flush(request.sessionId, request.speakerUuid).catch(this.onError);
    }
    return completion;
  }

  /** Keep waiting while live interim recognition shows the speaker has resumed. */
  noteSpeechActivity(sessionId: string, speakerUuid: string): void {
    const entry = this.sessions.get(sessionId)?.buffers.get(speakerUuid);
    if (!entry) return;
    this.cancel(entry.timer);
    entry.timer = this.schedule(() => this.flush(sessionId, speakerUuid).catch(this.onError), this.quietMs);
  }

  private async notifyOnce(state: SessionState, sessionId: string, eventIds: readonly string[],
    kind: 'ack' | 'failure', message: string): Promise<void> {
    if (eventIds.some(id => state.notices.has(`${kind}:${id}`))) return;
    await this.sendStatus(sessionId, message);
    for (const id of eventIds) state.notices.add(`${kind}:${id}`);
    while (state.notices.size > 2000) state.notices.delete(state.notices.values().next().value!);
  }

  private async flush(sessionId: string, speakerUuid: string): Promise<void> {
    const state = this.sessions.get(sessionId); const entry = state?.buffers.get(speakerUuid);
    if (!state || !entry) return;
    state.buffers.delete(speakerUuid);
    const ordered = [...entry.fragments].sort((a, b) =>
      (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.sequence - b.sequence);
    const text = ordered.map(fragment => fragment.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const eventId = `attendee-combined-${createHash('sha256').update(ordered.map(fragment => fragment.eventId).join('\0')).digest('hex')}`;
    try {
      const bound = state.bindings.get(speakerUuid);
      const actor = bound ?? entry.actor;
      if (!actor.verified) {
        if (state.owner && state.challenge && normalized(text) === normalized(state.challenge)) {
          await this.sendStatus(sessionId, `Verified ${state.owner.displayName} for this meeting.`);
          state.bindings.set(speakerUuid, state.owner);
        } else if (directlyAddressesNogita(text)) {
          const guidance = state.challenge
            ? `I heard you, but I cannot verify this speaker. Please repeat: ${state.challenge}`
            : 'I heard you, but I cannot verify this speaker. Start the session with an authorized owner.';
          await this.sendStatus(sessionId, guidance);
        }
      } else {
        const at = ordered.find(fragment => fragment.at !== undefined)?.at;
        if (directlyAddressesNogita(text) && isExplicitLeaveRequest(removeAddress(text)) && this.onLeave) {
          await this.onLeave(sessionId);
        } else {
          if (directlyAddressesNogita(text)) {
            try { await this.notifyOnce(state, sessionId, ordered.map(fragment => fragment.eventId), 'ack',
              'I heard you. I’m checking that now.'); }
            catch (error) { this.onError(error); }
          }
          await this.emit(sessionId, { eventId, actor, text, ...(at === undefined ? {} : { at }) });
        }
      }
      for (const waiter of entry.waiters) waiter.resolve();
    } catch (error) {
      this.onError(error);
      // A completed but malformed planner response is terminal for this utterance.
      // Transient transport/provider errors still release the event for a bounded retry.
      const terminal = error instanceof InvalidPlanningResponseError;
      if (!terminal) for (const fragment of ordered) state.acceptedEventIds.delete(fragment.eventId);
      try {
        await this.notifyOnce(state, sessionId, ordered.map(fragment => fragment.eventId), 'failure',
          'I could not complete that request. Please try again; you can still ask me to leave.');
      } catch { /* The delivery retry is bounded by the durable queue. */ }
      for (const waiter of entry.waiters) {
        if (terminal) waiter.resolve(); else waiter.reject(error);
      }
    }
  }

  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const entry of state.buffers.values()) {
      this.cancel(entry.timer);
      for (const waiter of entry.waiters) waiter.resolve();
    }
    state.buffers.clear(); state.bindings.clear(); state.acceptedEventIds.clear(); state.notices.clear();
    this.sessions.delete(sessionId);
  }

  sessionCount(): number { return this.sessions.size; }
}
