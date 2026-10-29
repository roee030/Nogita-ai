import { createHash, randomInt } from 'node:crypto';
import { InvalidPlanningResponseError, type Actor, type Utterance } from '../core/contracts.ts';
import { directlyAddressesNogita, isExplicitLeaveRequest, normalizeWakeWord, removeAddress } from '../core/policy.ts';
import type { AttendeeTranscriptRequest } from './attendee-webhook.ts';

type ScheduledWork = () => void | Promise<void>;
interface Fragment { text: string; eventId: string; at?: number; sequence: number }
interface BufferEntry {
  actor: Actor; fragments: Fragment[]; timer: unknown; receivedAt: number;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}
/** An answer started on Deepgram's early end-of-turn, kept until the turn is confirmed or resumed. */
export interface EarlyStart { cancel(): void }
export interface EmitContext { speakerKey: string; speculation?: EarlyStart }
interface SessionState {
  owner?: Actor;
  speculations: Map<string, { text: string; handle: EarlyStart }>;
  challenge?: string;
  bindings: Map<string, Actor>;
  buffers: Map<string, BufferEntry>;
  acceptedEventIds: Set<string>;
  notices: Set<string>;
}
export interface AttendeeCommandRouterOptions {
  quietMs?: number;
  /** Shorter wait for a finished question to Nogita ("Nogita, ... ?"); the full window still applies if the
   *  speaker keeps talking. Measured in the voice lab: the full window was the largest single delay. */
  questionQuietMs?: number;
  /** Post "I heard you" in chat for each request (default). Off for live voice, where her spoken lead-in says it
   *  and the note contradicted quick spoken answers. */
  chatAck?: boolean;
  /** How long a turn that is only her name ("Nogita.") waits for the question that follows. */
  nameOnlyMs?: number;
  randomCode?: () => string;
  schedule?: (work: ScheduledWork, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
  onLeave?: (sessionId: string) => Promise<void>;
  onChatAck?: (sessionId: string, durationMs: number) => void;
  onSpeechActivity?: (sessionId: string, speakerUuid: string) => void;
  /** Starts an answer from an early end-of-turn; nothing may be said or changed until the turn is confirmed. */
  speculate?: (sessionId: string, utterance: Utterance) => EarlyStart | undefined;
}

const spokenDigits: Readonly<Record<string, string>> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

function matchesSpokenChallenge(text: string, challenge: string): boolean {
  const expected = /^Nogita verify (\d{6})$/.exec(challenge)?.[1];
  if (!expected) return false;
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Only these wake-word variants were observed in the provider transcript.
  const spoken = /^(?:(?:ah|um|no) )?(?:nogita|nogeta|novita) verify (.+)$/.exec(words)?.[1];
  if (!spoken) return false;
  let digits = '';
  for (const token of spoken.split(' ')) {
    const part = /^\d+$/.test(token) ? token : spokenDigits[token];
    if (part === undefined) return false;
    digits += part;
    if (digits.length > 6) return false;
  }
  return digits === expected;
}

export class AttendeeCommandRouter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly quietMs: number;
  private readonly questionQuietMs: number;
  private readonly nameOnlyMs: number;
  private readonly chatAck: boolean;
  private readonly randomCode: () => string;
  private readonly schedule: (work: ScheduledWork, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private readonly onLeave?: (sessionId: string) => Promise<void>;
  private readonly onChatAck?: (sessionId: string, durationMs: number) => void;
  private readonly onSpeechActivity?: (sessionId: string, speakerUuid: string) => void;
  private readonly speculate?: AttendeeCommandRouterOptions['speculate'];
  private sequence = 0;

  constructor(
    private readonly emit: (sessionId: string, utterance: Utterance, context: EmitContext) => Promise<void>,
    private readonly sendStatus: (sessionId: string, message: string) => Promise<void>,
    options: AttendeeCommandRouterOptions = {},
  ) {
    this.quietMs = options.quietMs ?? 1200;
    this.questionQuietMs = Math.min(this.quietMs, options.questionQuietMs ?? 300);
    this.nameOnlyMs = options.nameOnlyMs ?? 2_500;
    this.chatAck = options.chatAck ?? true;
    this.randomCode = options.randomCode ?? (() => String(randomInt(100000, 1000000)));
    this.schedule = options.schedule ?? ((work, delayMs) => setTimeout(() => { void work(); }, delayMs));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => {});
    this.onLeave = options.onLeave;
    this.onChatAck = options.onChatAck;
    this.onSpeechActivity = options.onSpeechActivity;
    this.speculate = options.speculate;
  }

  beginSession(sessionId: string, owner?: Actor): string | undefined {
    this.endSession(sessionId);
    if (owner && !owner.verified) throw new Error('meeting owner must be verified');
    const challenge = owner ? `Nogita verify ${this.randomCode()}` : undefined;
    this.sessions.set(sessionId, {
      ...(owner ? { owner, challenge } : {}), bindings: new Map(), buffers: new Map(), acceptedEventIds: new Set(),
      notices: new Set(), speculations: new Map(),
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
    const entry: BufferEntry = { actor, fragments, waiters: [...(previous?.waiters ?? []), { resolve, reject }],
      timer: undefined, receivedAt: previous?.receivedAt ?? performance.now() };
    entry.timer = this.schedule(() => this.flush(request.sessionId, request.speakerUuid).catch(this.onError),
      this.quietWindow(fragments));
    state.buffers.set(request.speakerUuid, entry);
    return completion;
  }

  /**
   * A complete question or request addressed to Nogita ("Nogita, ...?", "Nogita, show me the open tasks.") needs no
   * long wait for more words. If the speaker does go on, the engine answers the whole question instead.
   */
  private quietWindow(fragments: readonly Fragment[]): number {
    const text = normalizeWakeWord(fragments.map(fragment => fragment.text).join(' ').trim());
    if (!directlyAddressesNogita(text)) return this.quietMs;
    if (text.endsWith('?')) return this.questionQuietMs;
    const words = removeAddress(text).split(/\s+/).filter(Boolean).length;
    return /[.!]$/.test(text) && words >= 4 ? this.questionQuietMs : this.quietMs;
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
      // Flux sometimes ends a turn at the pause after the name ("Nogita."): wait for the question itself.
      const text = normalizeWakeWord(entry.fragments.map(fragment => fragment.text).join(' ').trim());
      if (NAME_ONLY.test(text)) {
        entry.timer = this.schedule(() => this.flush(request.sessionId, request.speakerUuid).catch(this.onError), this.nameOnlyMs);
      } else void this.flush(request.sessionId, request.speakerUuid).catch(this.onError);
    }
    return completion;
  }

  /**
   * Deepgram Flux thinks the speaker is probably done (EagerEndOfTurn). The answer starts now from these words;
   * the confirmed turn adopts it if the words match, and `resumeTurn` rolls it back if they keep talking.
   */
  acceptEagerTurn(request: AttendeeTranscriptRequest): void {
    const state = this.sessions.get(request.sessionId);
    if (!state || !this.speculate) return;
    const previous = state.buffers.get(request.speakerUuid);
    const text = normalizeWakeWord([...(previous?.fragments ?? []).map(fragment => fragment.text), request.utterance.text.trim()]
      .join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000));
    const actor = state.bindings.get(request.speakerUuid) ??
      (request.utterance.actor.verified ? request.utterance.actor : previous?.actor);
    this.resumeTurn(request.sessionId, request.speakerUuid);
    if (!actor?.verified || !directlyAddressesNogita(text)) return;
    const handle = this.speculate(request.sessionId, { eventId: `${request.utterance.eventId}-early`, actor, text,
      ...(request.utterance.at === undefined ? {} : { at: request.utterance.at }) });
    if (handle) state.speculations.set(request.speakerUuid, { text, handle });
  }

  /** The speaker kept talking after an early end-of-turn: drop the early start. */
  resumeTurn(sessionId: string, speakerUuid: string): void {
    const state = this.sessions.get(sessionId);
    const early = state?.speculations.get(speakerUuid);
    if (!state || !early) return;
    state.speculations.delete(speakerUuid);
    early.handle.cancel();
  }

  /** Keep waiting while live interim recognition shows the speaker has resumed. */
  noteSpeechActivity(sessionId: string, speakerUuid: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.onSpeechActivity?.(sessionId, speakerUuid);
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
    const text = normalizeWakeWord(ordered.map(fragment => fragment.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000));
    const eventId = `attendee-combined-${createHash('sha256').update(ordered.map(fragment => fragment.eventId).join('\0')).digest('hex')}`;
    // An early start counts only for the same words; anything else is rolled back here or by the engine.
    const early = state.speculations.get(speakerUuid);
    state.speculations.delete(speakerUuid);
    const speculation = early && sameWords(early.text, text) ? early.handle : undefined;
    if (early && !speculation) early.handle.cancel();
    let handedOver = false;
    try {
      const bound = state.bindings.get(speakerUuid);
      const actor = bound ?? entry.actor;
      if (!actor.verified) {
        if (state.owner && state.challenge && matchesSpokenChallenge(text, state.challenge)) {
          await this.sendStatus(sessionId, `Verified ${state.owner.displayName} for this meeting.`);
          this.onChatAck?.(sessionId, performance.now() - entry.receivedAt);
          state.bindings.set(speakerUuid, state.owner);
        } else if (directlyAddressesNogita(text)) {
          const guidance = state.challenge
            ? `I heard you, but I cannot verify this speaker. Please repeat: ${state.challenge}`
            : 'I heard you, but I cannot verify this speaker. Start the session with an authorized owner.';
          await this.sendStatus(sessionId, guidance);
          this.onChatAck?.(sessionId, performance.now() - entry.receivedAt);
        }
      } else {
        const at = ordered.find(fragment => fragment.at !== undefined)?.at;
        if (directlyAddressesNogita(text) && isExplicitLeaveRequest(removeAddress(text)) && this.onLeave) {
          await this.onLeave(sessionId);
        } else {
          if (this.chatAck && directlyAddressesNogita(text)) {
            // The chat note goes out alongside the answer; waiting for it delayed every spoken reply.
            void this.notifyOnce(state, sessionId, ordered.map(fragment => fragment.eventId), 'ack',
              'I heard you. I’m checking that now.')
              .then(() => this.onChatAck?.(sessionId, performance.now() - entry.receivedAt), error => this.onError(error));
          }
          handedOver = true;
          await this.emit(sessionId, { eventId, actor, text, ...(at === undefined ? {} : { at }) },
            { speakerKey: speakerUuid, ...(speculation ? { speculation } : {}) });
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
    } finally {
      if (speculation && !handedOver) speculation.cancel();
    }
  }

  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const early of state.speculations.values()) early.handle.cancel();
    state.speculations.clear();
    for (const entry of state.buffers.values()) {
      this.cancel(entry.timer);
      for (const waiter of entry.waiters) waiter.resolve();
    }
    state.buffers.clear(); state.bindings.clear(); state.acceptedEventIds.clear(); state.notices.clear();
    this.sessions.delete(sessionId);
  }

  sessionCount(): number { return this.sessions.size; }
}

const NAME_ONLY = /^(?:(?:hey|hi|hello|okay|ok|um|uh|so|and),?\s+)?nogita[\s,.:!?-]*$/i;

function sameWords(a: string, b: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return words(a) === words(b);
}
