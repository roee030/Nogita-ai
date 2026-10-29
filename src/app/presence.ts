/**
 * Nogita's presence screen: one truthful state per meeting (ready, listening, thinking, speaking, a problem),
 * derived only from real runtime signals, streamed to the shared page over Server-Sent Events.
 *
 * - listening: someone said her name and is still talking, or a question was heard early and is not confirmed yet
 * - thinking: a confirmed question is open (with the tool she is actually running, or "waiting for a pause")
 * - speaking: her speech audio is being sent to the meeting right now
 * - error: a real failure (a provider error, an answer that failed); it clears by itself
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ScreenCard } from '../core/contracts.ts';

export type PresenceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'leaving';

export interface PresenceSnapshot {
  state: PresenceState;
  /** The headline under the state ("Searching the code", "Waiting for a pause"). */
  status: string;
  /** What she heard: the open question's topic or opening words. */
  about?: string;
  /** Questions still open (more than one shows a small queue indicator). */
  open: number;
  tone?: 'warning' | 'error';
}

export interface PresenceQuestion {
  id: number;
  status: string;
  request: string;
  topic?: string;
}

type Send = (event: string, data: unknown) => void;

interface OpenQuestion { request: string; topic?: string; status: string; since: number; tool?: string }

interface PresenceSession {
  key: string;
  questions: Map<number, OpenQuestion>;
  /** Speaker whose words named Nogita, and until when that counts as listening. */
  addressedBy?: string;
  addressedUntil: number;
  /** When the audio sent so far finishes playing. */
  audioEnd: number;
  speakingUntil: number;
  card?: ScreenCard;
  cardShownAt: number;
  waiting: boolean;
  problem?: { tone: 'warning' | 'error'; text: string; until: number };
  leaving: boolean;
  last?: string;
  subscribers: Set<Send>;
  timer?: unknown;
  inputLevel: number;
  inputSentAt: number;
}

const TERMINAL = new Set(['answered', 'chat_only', 'cancelled', 'stopped', 'failed', 'rolled_back', 'superseded', 'duplicate']);
const SAMPLE_RATE = 16_000;
/** Speech level frames for the page (one value per 40 ms of audio). */
const FRAME_MS = 40;
const CARD_MS = 5 * 60_000;

export interface PresenceOptions {
  now?: () => number;
  schedule?: (work: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Provider names for tool labels ("Checking Jira"). */
  boardName?: string;
  chatName?: string;
  /** How long a named speaker still counts as talking to her after their last sound. */
  addressedMs?: number;
}

/** 0..1 from an RMS level: -50 dBFS is silence, -10 dBFS is loud speech. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 50) / 40));
}

/** Loudness of 16-bit PCM in 40 ms frames. */
export function pcmLevels(pcm: Buffer): number[] {
  const samples = pcm.length >> 1;
  const perFrame = SAMPLE_RATE * FRAME_MS / 1000;
  const levels: number[] = [];
  for (let start = 0; start < samples; start += perFrame) {
    const end = Math.min(samples, start + perFrame);
    let sum = 0;
    for (let i = start; i < end; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
    levels.push(Math.round(levelFromRms(Math.sqrt(sum / Math.max(1, end - start))) * 100) / 100);
  }
  return levels;
}

function opening(request: string): string {
  const words = request.replace(/\s+/g, ' ').trim().split(' ');
  const text = words.slice(0, 9).join(' ');
  return words.length > 9 ? `${text.replace(/[,.;:!?]+$/, '')}…` : text;
}

export class PresenceHub {
  private readonly sessions = new Map<string, PresenceSession>();
  private readonly now: () => number;
  private readonly schedule: (work: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: PresenceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((work, delayMs) => {
      const handle = setTimeout(work, delayMs);
      handle.unref?.();
      return handle;
    });
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Starts a meeting's presence; returns the key that the shared page must present. */
  open(sessionId: string): string {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.key;
    const key = randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, { key, questions: new Map(), addressedUntil: 0, audioEnd: 0, speakingUntil: 0, cardShownAt: 0, waiting: false,
      leaving: false, subscribers: new Set(), inputLevel: 0, inputSentAt: 0 });
    return key;
  }

  has(sessionId: string): boolean { return this.sessions.has(sessionId); }

  authorized(sessionId: string, key: string | null | undefined): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !key) return false;
    const a = Buffer.from(session.key); const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The page shows "Leaving" and the streams end shortly after. */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.leaving = true;
    this.update(sessionId, session);
    if (session.timer !== undefined) this.cancel(session.timer);
    this.sessions.delete(sessionId);
    const subscribers = [...session.subscribers];
    session.subscribers.clear();
    this.schedule(() => { for (const send of subscribers) send('end', {}); }, 1_500);
  }

  subscribe(sessionId: string, send: Send): (() => void) | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.subscribers.add(send);
    send('state', this.snapshot(session));
    if (session.card) send('card', { card: session.card });
    return () => { session.subscribers.delete(send); };
  }

  snapshotFor(sessionId: string): PresenceSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session && this.snapshot(session);
  }

  // Signals from the meeting runtime.

  question(sessionId: string, event: PresenceQuestion): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (TERMINAL.has(event.status)) {
      session.questions.delete(event.id);
      if (event.status === 'failed') this.setProblem(session, 'warning', 'Having trouble responding', 6_000);
    } else {
      const known = session.questions.get(event.id);
      const confirmed = known && known.status === 'speculative' && event.status !== 'speculative';
      session.questions.set(event.id, { request: event.request, topic: event.topic ?? known?.topic, status: event.status,
        since: !known || confirmed ? this.now() : known.since, tool: event.status === 'working' ? known?.tool : undefined });
      // A confirmed question ends the listening that led to it.
      if (event.status !== 'speculative') session.addressedUntil = 0;
    }
    this.update(sessionId, session);
  }

  tool(sessionId: string, questionId: number | undefined, names: readonly string[]): void {
    const session = this.sessions.get(sessionId);
    const question = questionId === undefined ? undefined : session?.questions.get(questionId);
    if (!session || !question || !names.length) return;
    question.tool = names[0];
    this.update(sessionId, session);
  }

  /** Her answer is ready but people are talking: it waits for an opening. */
  waiting(sessionId: string, waiting: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.waiting === waiting) return;
    session.waiting = waiting;
    this.update(sessionId, session);
  }

  /** Words on the live transcript named Nogita. */
  addressed(sessionId: string, speaker: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.addressedBy = speaker;
    session.addressedUntil = this.now() + (this.options.addressedMs ?? 3_000);
    this.update(sessionId, session);
  }

  /** Someone's own voice on their microphone: keeps listening alive while the person who named her talks. */
  voice(sessionId: string, speaker: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.addressedBy !== speaker || session.addressedUntil <= this.now()) return;
    session.addressedUntil = this.now() + (this.options.addressedMs ?? 3_000);
    this.update(sessionId, session);
  }

  /** Loudness of the room (RMS of a participant's audio frame); sent at most about 12 times a second. */
  inputLevel(sessionId: string, rms: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.subscribers.size) return;
    session.inputLevel = Math.max(session.inputLevel, levelFromRms(rms));
    if (this.now() - session.inputSentAt < 80) return;
    session.inputSentAt = this.now();
    const level = Math.round(session.inputLevel * 100) / 100;
    session.inputLevel = 0;
    for (const send of session.subscribers) send('in', { l: level });
  }

  /** Her speech audio, sent to the meeting at playback pace: she is speaking, at these levels. */
  outputAudio(sessionId: string, pcm: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || !pcm.length) return;
    const durationMs = (pcm.length >> 1) * 1000 / SAMPLE_RATE;
    const wasSpeaking = session.speakingUntil > this.now();
    // Chunks are sent at playback pace: each one plays after the audio before it, then a short tail.
    session.audioEnd = Math.max(session.audioEnd, this.now()) + durationMs;
    session.speakingUntil = session.audioEnd + 350;
    if (session.subscribers.size) {
      const levels = pcmLevels(pcm);
      for (const send of session.subscribers) send('out', { f: FRAME_MS, l: levels });
    }
    if (!wasSpeaking) this.update(sessionId, session);
    else this.wake(sessionId, session);
  }

  /** A card she was asked to show (a task, a task list, code) beside her orb; undefined clears it. */
  show(sessionId: string, card: ScreenCard | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.card = card;
    session.cardShownAt = this.now();
    for (const send of session.subscribers) send('card', { card: card ?? null });
    this.wake(sessionId, session);
  }

  /** A real failure: shown for a while, then the screen goes back to the true state. */
  problem(sessionId: string, tone: 'warning' | 'error', text: string, ttlMs = 8_000): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.setProblem(session, tone, text, ttlMs);
    this.update(sessionId, session);
  }

  private setProblem(session: PresenceSession, tone: 'warning' | 'error', text: string, ttlMs: number): void {
    session.problem = { tone, text, until: this.now() + ttlMs };
  }

  private snapshot(session: PresenceSession): PresenceSnapshot {
    const now = this.now();
    const open = [...session.questions.values()].filter(q => q.status !== 'speculative');
    const newest = open.sort((a, b) => b.since - a.since)[0];
    const about = (q?: OpenQuestion) => q ? (q.topic ?? opening(q.request)) : undefined;
    const count = open.length;
    if (session.leaving) return { state: 'leaving', status: 'Leaving the meeting', open: 0 };
    if (session.problem && session.problem.until > now) {
      return { state: 'error', status: session.problem.text, open: count, tone: session.problem.tone };
    }
    if (session.speakingUntil > now) {
      const answering = open.find(q => q.status === 'answering') ?? newest;
      return { state: 'speaking', status: 'Answering', ...(answering ? { about: about(answering) } : {}), open: count };
    }
    if (newest) {
      const status = session.waiting ? 'Ready to answer · waiting for a pause'
        : newest.status === 'interrupted' ? 'Holding my answer until you finish'
        : newest.tool ? this.toolLabel(newest.tool)
        : now - newest.since < 1_500 ? 'Got it' : 'Working on your question';
      return { state: 'thinking', status, about: about(newest), open: count };
    }
    const heard = [...session.questions.values()].some(q => q.status === 'speculative');
    if (heard || session.addressedUntil > now) return { state: 'listening', status: 'Listening', open: 0 };
    return { state: 'idle', status: 'Ready', open: 0 };
  }

  private toolLabel(tool: string): string {
    const board = this.options.boardName ?? 'the board';
    const chat = this.options.chatName ?? 'chat';
    switch (tool) {
      case 'search_code': return 'Searching the code';
      case 'read_file': return 'Reading the code';
      case 'list_files': return 'Looking through the repository';
      case 'recent_commits': return 'Checking recent commits';
      case 'search_tasks': case 'get_task': return `Checking ${board}`;
      case 'create_task': return `Creating a task in ${board}`;
      case 'list_channels': case 'read_channel': case 'search_messages': return `Checking ${chat}`;
      case 'post_message': return `Posting to ${chat}`;
      default: return 'Looking that up';
    }
  }

  private update(sessionId: string, session: PresenceSession): void {
    // A shown card stays for a few minutes unless replaced or cleared.
    if (session.card && this.now() >= session.cardShownAt + CARD_MS) {
      session.card = undefined;
      for (const send of session.subscribers) send('card', { card: null });
    }
    const snapshot = this.snapshot(session);
    const serialized = JSON.stringify(snapshot);
    if (serialized !== session.last) {
      session.last = serialized;
      for (const send of session.subscribers) send('state', snapshot);
    }
    this.wake(sessionId, session);
  }

  /** Re-derive when a time-limited signal (speech, listening, "got it", a problem) runs out. */
  private wake(sessionId: string, session: PresenceSession): void {
    if (session.timer !== undefined) { this.cancel(session.timer); session.timer = undefined; }
    const now = this.now();
    const deadlines = [session.speakingUntil, session.addressedUntil, session.problem?.until ?? 0,
      session.card ? session.cardShownAt + CARD_MS : 0,
      ...[...session.questions.values()].map(q => q.since + 1_500)].filter(at => at > now);
    if (!deadlines.length) return;
    session.timer = this.schedule(() => {
      session.timer = undefined;
      if (this.sessions.get(sessionId) === session) this.update(sessionId, session);
    }, Math.min(...deadlines) - now + 5);
  }
}
