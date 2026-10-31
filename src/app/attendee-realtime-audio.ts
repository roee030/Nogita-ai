import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SpeechInterruptedError, type SpeechTrace } from '../core/contracts.ts';

const AUDIO_PATH = '/webhooks/attendee/audio';
const AUDIO_SAMPLE_RATE = 16_000;
const MAX_ATTENDEE_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 32;
// Audio held while a speaker's Deepgram stream connects. A frame count was not enough: at 20 ms frames,
// 32 frames is 0.64 s, shorter than a slow handshake, so the stream was closed and reopened while the
// person kept talking (found by the voice lab). Five seconds of 16 kHz PCM is 160 kB.
const MAX_PENDING_SPEAKER_BYTES = 5 * AUDIO_SAMPLE_RATE * 2;
const MAX_PARTICIPANTS_PER_SESSION = 16;
const MAX_TTS_TURN_BYTES = 5 * 1024 * 1024;
const DEEPGRAM_IDLE_MS = 10_000;
/** In v2, output is paused at the acoustic gate; abandon it if continuous speech outlives STT's backchannel window. */
const BARGE_IN_CANCEL_MS = 1_500;
const BACKCHANNEL_PAUSE_MAX_MS = 1_500;
/**
 * A pause the recognizer heard no speech in (a cough, a laugh, a chair) ends this long after the sound does. In the
 * voice lab Flux reported no activity at all for coughs and laughter, and the 1.5 s backchannel window left her silent
 * for about 2 s each time; once recognition hears speech, the longer window applies so a "yeah" can be told apart.
 */
const QUIET_RESUME_MS = 350;
/** Preserve onset through short unvoiced phonemes, but not across separate utterances. */
const VOICE_RUN_GRACE_MS = 180;
/** Flux early end-of-turn confidence for speculative starts (DEEPGRAM_EAGER_EOT_THRESHOLD; "off" disables them). */
export const DEFAULT_EAGER_EOT_THRESHOLD = 0.5;

export type SttMode = 'nova3-multilingual' | 'flux-english';
/** Languages Nogita must understand unless NOGITA_LANGUAGES says otherwise: English (decided 2026-10-30). */
export const DEFAULT_LANGUAGES: readonly string[] = ['en'];

/**
 * The recognizer for the meeting's languages. Deepgram Flux is English only (flux-general-en; flux-general-multi has no
 * Hebrew), so it is used only when every configured language is English. Nova-3 with language=multi transcribes Hebrew
 * and mixed Hebrew-English. Unset: Flux for an English-only meeting (its early end-of-turn lets her start answering
 * sooner: voice lab 2026-10-30, p50 3.1 s -> 1.9 s), else Nova-3. `refused` explains a requested mode that was not used.
 */
export function chooseSttMode(requested: string | undefined, languages: readonly string[]): { mode: SttMode; refused?: string } {
  const other = languages.filter(language => language !== 'en');
  if (!requested) return { mode: other.length ? 'nova3-multilingual' : 'flux-english' };
  if (requested !== 'flux-english') return { mode: 'nova3-multilingual' };
  return other.length ? { mode: 'nova3-multilingual', refused: `Flux does not support ${other.join(', ')}` } : { mode: 'flux-english' };
}

/** NOGITA_LANGUAGES ("en", or "en,he") as two-letter codes; the default when unset or invalid. */
export function parseLanguages(value: string | undefined): string[] {
  const codes = (value ?? '').split(',').map(code => code.trim().toLowerCase()).filter(Boolean);
  return codes.length && codes.every(code => /^[a-z]{2}$/.test(code)) ? [...new Set(codes)] : [...DEFAULT_LANGUAGES];
}

export interface AttendeeAudioFrame {
  botId: string;
  participantUuid: string;
  audio: Buffer;
  sampleRate: 16_000;
}

function signature(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`nogita-attendee-audio-v1\0${sessionId}`).digest('base64url');
}

export function createAttendeeAudioSocketUrl(baseUrl: string, secret: string, sessionId: string): string {
  if (!secret.trim() || !sessionId || sessionId.length > 100) throw new Error('audio websocket signing configuration is invalid');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('audio websocket URL is invalid'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== AUDIO_PATH || url.hash) {
    throw new Error('audio websocket URL must be credential-free WSS at the Attendee audio path');
  }
  if (url.search) throw new Error('audio websocket base URL cannot include query parameters');
  url.searchParams.set('session_id', sessionId);
  url.searchParams.set('signature', signature(secret, sessionId));
  return url.toString();
}

export function verifyAttendeeAudioSignature(secret: string, sessionId: string, supplied: string): boolean {
  if (!secret || !sessionId || sessionId.length > 100 || !supplied) return false;
  const expected = Buffer.from(signature(secret, sessionId));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseAttendeeAudioFrame(payload: unknown, expectedBotId?: string): AttendeeAudioFrame | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== 'object') return null;
  const audio = data as Record<string, unknown>;
  if (root.trigger !== 'realtime_audio.per_participant' || typeof root.bot_id !== 'string' ||
      !/^bot_[a-zA-Z0-9_-]+$/.test(root.bot_id) || (expectedBotId && root.bot_id !== expectedBotId) ||
      typeof audio.participant_uuid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(audio.participant_uuid) ||
      audio.sample_rate !== AUDIO_SAMPLE_RATE || typeof audio.chunk !== 'string' ||
      audio.chunk.length > Math.ceil(MAX_ATTENDEE_FRAME_BYTES * 4 / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.chunk)) return null;
  const decoded = Buffer.from(audio.chunk, 'base64');
  if (!decoded.length || decoded.length > MAX_ATTENDEE_FRAME_BYTES || decoded.length % 2 !== 0) return null;
  return { botId: root.bot_id, participantUuid: audio.participant_uuid, audio: decoded, sampleRate: AUDIO_SAMPLE_RATE };
}

export function assembleNova3Turn(message: unknown, pendingFinalSegments: string[]): string | null {
  if (!message || typeof message !== 'object') return null;
  const result = message as Record<string, unknown>;
  // Steady background noise (hum, typing, nearby talk) keeps silence-based endpointing from ever firing;
  // UtteranceEnd is decided from word timings instead, so it still closes the turn in a noisy room.
  if (result.type === 'UtteranceEnd') {
    const completed = pendingFinalSegments.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    pendingFinalSegments.length = 0;
    return completed || null;
  }
  if (result.type === 'TurnInfo') {
    return result.event === 'EndOfTurn' && typeof result.transcript === 'string'
      ? result.transcript.trim().slice(0, 4000) || null : null;
  }
  const channel = result.channel;
  const alternatives = channel && typeof channel === 'object'
    ? (channel as Record<string, unknown>).alternatives : undefined;
  const first = Array.isArray(alternatives) ? alternatives[0] : undefined;
  const transcript = first && typeof first === 'object' && typeof (first as Record<string, unknown>).transcript === 'string'
    ? ((first as Record<string, unknown>).transcript as string).trim() : '';
  if (!transcript) return null;

  if (result.is_final === true || result.speech_final === true) {
    if (pendingFinalSegments.at(-1) !== transcript) pendingFinalSegments.push(transcript);
    if (pendingFinalSegments.length > 24) pendingFinalSegments.splice(0, pendingFinalSegments.length - 24);
  }
  if (result.speech_final !== true) return null;
  const completed = pendingFinalSegments.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  pendingFinalSegments.length = 0;
  return completed || null;
}

export interface RealtimeAudioOptions {
  baseUrl: string;
  signingSecret: string;
  deepgramApiKey: string;
  /** Exclude meeting audio, transcripts, TTS text and synthesized audio from Deepgram model improvement. Default true. */
  deepgramMipOptOut?: boolean;
  sttMode?: SttMode;
  /** Language hints for Nova-3 multilingual (default English). */
  languages?: readonly string[];
  ttsModel?: string;
  /** Flux end-of-turn confidence. Deepgram's default 0.7 ended turns at the pause after "Nogita," in the voice lab,
   *  so she answered her own name and was cut off by the rest of the question; 0.8 waits for the question. */
  fluxEndOfTurnThreshold?: number;
  /** Flux early end-of-turn confidence: an answer may start (speculatively) at this point, before the turn is
   *  confirmed. Unset: no early starts. */
  fluxEagerEndOfTurnThreshold?: number;
  /** Keep a speech connection open for the whole meeting: a cold one cost 0.7-1.4 s before the first word. */
  warmSpeech?: boolean;
  /** Measured pause-and-classify interruption profile. Disabled unless rollout explicitly enables it. */
  turnTakingV2?: boolean;
  /** Words the recognizer should expect (Deepgram keyterm prompting); always includes the wake word. */
  keyterms?: readonly string[];
  /** Synthesis watchdog; playback may continue after Deepgram confirms Flush. */
  ttsSynthesisTimeoutMs?: number;
  onTranscript: (sessionId: string, participantUuid: string, transcript: string,
    identity?: { attendeeUserUuid?: string; displayName?: string },
    recognition?: { confidence?: number; inputTurnId?: string }) => void | Promise<void>;
  onSpeechActivity?: (sessionId: string, participantUuid: string) => void;
  /** A participant's own voice on their microphone (audio level, within about 100 ms; no transcript). */
  onVoice?: (sessionId: string, participantUuid: string) => void;
  /** Live (not yet final) words of a participant's turn. */
  onInterim?: (sessionId: string, participantUuid: string, text: string) => void;
  /** RMS level of a participant's own-voice audio frame (for the presence screen). */
  onInputLevel?: (sessionId: string, rms: number) => void;
  /** Nogita's speech audio as it is sent to the meeting, at playback pace. */
  onOutputAudio?: (sessionId: string, pcm: Buffer, trace: SpeechTrace) => void;
  /** The first audio of a speak() call was sent to the meeting (the moment people start to hear her). */
  onSpeechStart?: (sessionId: string, trace: SpeechTrace & { ttfaMs: number }) => void;
  /** A speak() call ended: played to the end, cut off, or failed, with how much of it had played. */
  onSpeechEnd?: (sessionId: string, end: SpeechTrace & { outcome: 'done' | 'interrupted' | 'failed'; playedMs: number }) => void;
  /** Her speech was stopped: `latencyMs` from the participant's voice onset (or the stop request) to the stop. */
  onInterrupt?: (sessionId: string, interrupt: SpeechTrace & { cause: 'voice' | 'command'; latencyMs?: number; playedMs: number }) => void;
  /** Output paused while a short utterance is classified; it may resume when that utterance is a backchannel. */
  onSpeechPause?: (sessionId: string, pause: SpeechTrace & { latencyMs: number; playedMs: number; remainingMs: number }) => void;
  /** A classified backchannel or timeout released paused output; duration is measured on the hub clock. */
  onSpeechResume?: (sessionId: string, resume: SpeechTrace & {
    cause: 'backchannel' | 'quiet' | 'timeout'; pausedMs: number;
  }) => void;
  /** Flux EagerEndOfTurn: the speaker is probably done with these words. */
  onEagerTranscript?: (sessionId: string, participantUuid: string, transcript: string,
    identity?: { attendeeUserUuid?: string; displayName?: string }, inputTurnId?: string) => void;
  /** Flux TurnResumed: the speaker went on after an early end-of-turn. */
  onTurnResumed?: (sessionId: string, participantUuid: string) => void;
  /** Server receipt timing; the own-voice frame is an estimate, not a client microphone timestamp. */
  onTurnTiming?: (sessionId: string, participantUuid: string, event: {
    phase: 'eager' | 'confirmed' | 'resumed'; sinceLastVoiceMs?: number; inputTurnId: string;
  }) => void;
  onUsage?: (sessionId: string, usage: { sttBytes?: number; ttsCharacters?: number }) => void;
  authorizeRecoveredBot?: (sessionId: string, botId: string) => Promise<boolean>;
  onError?: (code: string) => void;
  now?: () => number;
  createWebSocket?: (url: string, options: { headers: Record<string, string>; perMessageDeflate: false }) => WebSocket;
}

export interface TurnTakingProfile {
  ownVoiceGateMs: number;
  ownVoicePeakRatio: number;
  pauseAndClassify: boolean;
}

/** One switch selects the complete measured profile, so rollback cannot leave half of it active. */
export function turnTakingProfile(enabled: boolean): TurnTakingProfile {
  return enabled
    ? { ownVoiceGateMs: 80, ownVoicePeakRatio: 0.35, pauseAndClassify: true }
    : { ownVoiceGateMs: 100, ownVoicePeakRatio: 0.5, pauseAndClassify: false };
}

interface SpeakerStream {
  inputTurnId: string;
  socket: WebSocket;
  pendingAudio: Buffer[];
  finalSegments: string[];
  /** Recognition confidence of this turn's final segments (Nova-3), averaged when the turn is delivered. */
  confidences: number[];
  /** Own-voice gate: the speaker's quiet level, their speech level, and until when they were audibly talking. */
  noiseFloor?: number;
  speechPeak: number;
  loudUntil: number;
  loudRunMs: number;
  /** Silence fed to the recognizer after the participant's audio stops (muted right after speaking). */
  quietTimer?: ReturnType<typeof setTimeout>;
  silencePump?: ReturnType<typeof setInterval>;
  lastAudioAt: number;
  lastTurnText?: string;
  lastTurnAt?: number;
  lastVoiceSignalAt: number;
  lastOwnVoiceAt?: number;
}

interface RealtimeSession {
  sessionId: string;
  recoverOnFirstFrame?: boolean;
  authorizingBot?: string;
  botId?: string;
  observedBotId?: string;
  attendeeSocket?: WebSocket;
  pendingFrames: unknown[];
  speakers: Map<string, SpeakerStream>;
  participantIdentity: Map<string, { attendeeUserUuid?: string; displayName?: string }>;
  ttsSocket?: WebSocket;
  ttsOpening?: Promise<WebSocket>;
  speechPreparation?: { abort: AbortController; trace: SpeechTrace };
  ttsPending?: { resolve: () => void; reject: (error: Error) => void;
    synthesisComplete: () => void; bytes: number; firstAudioAt?: number; lastAudioEndsAt?: number;
    sentMs: number; requestedAt: number; trace: SpeechTrace };
  /** When the latest own-voice run began on any microphone (interruption latency is measured from it). */
  voiceOnsetAt?: number;
  voiceOnsetParticipant?: string;
  ttsCarry?: Buffer;
  ttsQueue: Buffer[];
  ttsFlushed: boolean;
  /** Loudest speaking level heard from anyone in the meeting (the own-voice gate's room reference). */
  voicePeak: number;
  ttsTimer?: ReturnType<typeof setTimeout>;
  ttsPaused: boolean;
  ttsPausedAt?: number;
  /** Recognition reported speech since this pause began (see QUIET_RESUME_MS). */
  pauseHeardSpeech?: boolean;
  ttsPauseTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class AttendeeRealtimeAudioHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 100_000, perMessageDeflate: false });
  private readonly sessions = new Map<string, RealtimeSession>();
  private readonly now: () => number;
  private readonly createWebSocket: NonNullable<RealtimeAudioOptions['createWebSocket']>;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly turnTaking: TurnTakingProfile;

  constructor(private readonly options: RealtimeAudioOptions) {
    if (!options.signingSecret.trim() || !options.deepgramApiKey.trim()) throw new Error('realtime audio credentials are required');
    if (options.ttsModel && !/^aura-2-[a-z]+-en$/.test(options.ttsModel)) {
      throw new Error('unsupported Deepgram TTS model');
    }
    // Validate the origin and fixed route once at startup.
    createAttendeeAudioSocketUrl(options.baseUrl, options.signingSecret, 'configuration-check');
    this.now = options.now ?? Date.now;
    this.turnTaking = turnTakingProfile(options.turnTakingV2 === true);
    this.createWebSocket = options.createWebSocket ?? ((url, socketOptions) =>
      new WebSocket(url, { ...socketOptions, handshakeTimeout: 10_000, maxPayload: 100_000 }));
    this.cleanupTimer = setInterval(() => this.closeIdleSpeakers(), 5_000);
    this.cleanupTimer.unref();
  }

  register(sessionId: string): string {
    if (this.sessions.has(sessionId)) throw new Error('realtime audio session already registered');
    if (this.sessions.size >= 100) throw new Error('realtime audio session capacity reached');
    this.sessions.set(sessionId, this.newSession(sessionId));
    return createAttendeeAudioSocketUrl(this.options.baseUrl, this.options.signingSecret, sessionId);
  }

  bindBot(sessionId: string, botId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || !/^bot_[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('realtime audio session is not available');
    if (session.observedBotId && session.observedBotId !== botId) {
      session.attendeeSocket?.close(1008, 'bot mismatch');
      session.pendingFrames.length = 0;
      throw new Error('Attendee audio bot identity mismatch');
    }
    session.botId = botId;
    const pending = session.pendingFrames.splice(0);
    for (const frame of pending) this.processAttendeeFrame(sessionId, session, frame);
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  bindParticipant(sessionId: string, participantUuid: string,
    identity: { attendeeUserUuid?: string; displayName?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || !/^[a-zA-Z0-9_-]{1,128}$/.test(participantUuid)) return;
    session.participantIdentity.set(participantUuid, {
      ...(identity.attendeeUserUuid ? { attendeeUserUuid: identity.attendeeUserUuid } : {}),
      ...(identity.displayName ? { displayName: identity.displayName.slice(0, 200) } : {}),
    });
  }

  participantLeft(sessionId: string, participantUuid: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.participantIdentity.delete(participantUuid);
    const speaker = session.speakers.get(participantUuid);
    if (speaker) this.closeSpeaker(session, participantUuid, speaker);
  }

  handleUpgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean {
    let url: URL;
    try { url = new URL(request.url ?? '', 'http://localhost'); } catch { return false; }
    if (url.pathname !== AUDIO_PATH) return false;
    const sessionId = url.searchParams.get('session_id') ?? '';
    const supplied = url.searchParams.get('signature') ?? '';
    if (!verifyAttendeeAudioSignature(this.options.signingSecret, sessionId, supplied)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= 100) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return true;
      }
      session = this.newSession(sessionId);
      session.recoverOnFirstFrame = true;
      this.sessions.set(sessionId, session);
    }
    if (session.closed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(request, socket, head, client => {
      session.attendeeSocket?.close(1012, 'connection replaced');
      this.closeProviderSockets(session);
      session.attendeeSocket = client;
      client.on('message', data => this.onAttendeeMessage(sessionId, session, data));
      client.on('close', () => {
        if (session.attendeeSocket !== client) return;
        session.attendeeSocket = undefined;
        this.closeProviderSockets(session);
      });
      client.on('error', () => this.options.onError?.('attendee_audio_socket_error'));
      this.warmTts(session);
    });
    return true;
  }

  async speak(sessionId: string, text: string, trace: SpeechTrace = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.attendeeSocket?.readyState !== WebSocket.OPEN || !session.botId) {
      throw new Error('Attendee realtime audio is not connected');
    }
    if (!text.trim() || text.length > 2000) throw new Error('invalid realtime speech text');
    if (session.ttsPending || session.speechPreparation) throw new Error('realtime speech is already in progress');
    const requestedAt = this.now();
    const preparation = { abort: new AbortController(), trace: { questionId: trace.questionId, playbackId: trace.playbackId } };
    session.speechPreparation = preparation;
    let rejectOpening!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectOpening = () => reject(preparation.abort.signal.reason);
      preparation.abort.signal.addEventListener('abort', rejectOpening, { once: true });
    });
    let tts: WebSocket;
    try {
      tts = await Promise.race([this.openTts(session), cancelled]);
      preparation.abort.signal.throwIfAborted();
      if (session.closed || session.attendeeSocket?.readyState !== WebSocket.OPEN) throw new Error('Attendee realtime audio disconnected');
    } catch (error) {
      this.options.onSpeechEnd?.(sessionId, { ...preparation.trace, playedMs: 0,
        outcome: error instanceof SpeechInterruptedError ? 'interrupted' : 'failed' });
      throw error;
    } finally {
      preparation.abort.signal.removeEventListener('abort', rejectOpening);
      if (session.speechPreparation === preparation) session.speechPreparation = undefined;
    }
    await new Promise<void>((resolve, reject) => {
      let pending!: NonNullable<RealtimeSession['ttsPending']>;
      const timeout = setTimeout(() => {
        if (session.ttsPending !== pending) return;
        pending.reject(new Error('Deepgram TTS timed out'));
      }, this.options.ttsSynthesisTimeoutMs ?? 20_000);
      const settle = (error?: Error) => {
        clearTimeout(timeout);
        if (session.ttsPending === pending) {
          this.options.onSpeechEnd?.(sessionId, { ...pending.trace, outcome: !error ? 'done' : error instanceof SpeechInterruptedError ? 'interrupted' : 'failed',
            playedMs: error instanceof SpeechInterruptedError && error.playedMs !== undefined ? error.playedMs : this.playedMs(pending) });
          session.ttsPending = undefined;
          session.ttsQueue.length = 0;
          session.ttsFlushed = false;
          if (session.ttsTimer) clearTimeout(session.ttsTimer);
          session.ttsTimer = undefined;
          if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
          session.ttsPauseTimer = undefined;
          session.ttsPaused = false;
        }
        if (error) reject(error); else resolve();
      };
      pending = { resolve: () => settle(), reject: settle,
        synthesisComplete: () => clearTimeout(timeout), bytes: 0, sentMs: 0, requestedAt, trace: preparation.trace };
      session.ttsPending = pending;
      session.ttsCarry = Buffer.alloc(0);
      session.ttsQueue.length = 0;
      session.ttsFlushed = false;
      this.options.onUsage?.(sessionId, { ttsCharacters: text.length });
      try {
        tts.send(JSON.stringify({ type: 'Speak', text }));
        tts.send(JSON.stringify({ type: 'Flush' }));
      } catch { pending.reject(new Error('Deepgram TTS request could not be submitted')); }
    });
  }

  /**
   * Stop synthesizing and forwarding this turn: a participant's voice cut in, or the engine asked (stop, cancel,
   * correction). Audio still queued here is discarded; speak() rejects with how much had played.
   */
  interruptSpeech(sessionId: string, cause: 'voice' | 'command' = 'command'): boolean {
    const session = this.sessions.get(sessionId);
    const pending = session?.ttsPending;
    if (session?.speechPreparation) {
      const preparation = session.speechPreparation;
      session.speechPreparation = undefined;
      preparation.abort.abort(new SpeechInterruptedError(0));
      const onset = cause === 'voice' ? session.voiceOnsetAt : undefined;
      this.options.onInterrupt?.(sessionId, { ...preparation.trace, cause, playedMs: 0,
        ...(onset !== undefined ? { latencyMs: Math.max(0, this.now() - onset) } : {}) });
      return true;
    }
    if (!session || !pending) return false;
    if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
    session.ttsPauseTimer = undefined;
    session.ttsPaused = false;
    session.ttsPausedAt = undefined;
    const playedMs = this.playedMs(pending);
    const onset = cause === 'voice' ? session.voiceOnsetAt : undefined;
    this.options.onInterrupt?.(sessionId, { ...pending.trace, cause, playedMs, ...(onset !== undefined ? { latencyMs: Math.max(0, this.now() - onset) } : {}) });
    session.ttsQueue.length = 0;
    session.ttsCarry = Buffer.alloc(0);
    const interruptedSocket = session.ttsSocket;
    // A late Flushed or audio frame belongs to the old turn, never the next one.
    session.ttsSocket = undefined;
    if (interruptedSocket?.readyState === WebSocket.OPEN) {
      try { interruptedSocket.send(JSON.stringify({ type: 'Clear' })); }
      catch { this.options.onError?.('deepgram_tts_clear_failed'); }
    }
    pending.reject(new SpeechInterruptedError(playedMs));
    interruptedSocket?.close(1000, 'speech interrupted');
    // The answer to whoever interrupted should not wait for a new handshake.
    this.warmTts(session);
    return true;
  }

  /** Stop after the current paced frame, preserving the queued turn until recognition resolves a backchannel. */
  private pauseSpeech(session: RealtimeSession): void {
    const pending = session.ttsPending;
    if (!pending) return;
    if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
    // Continued voice extends the hold. A short acknowledgement resumes after its final transcript (or this
    // fallback); continuous speech never leaks the queued answer back into the meeting between audio frames.
    if (!session.ttsPaused) session.pauseHeardSpeech = false;
    this.armResume(session);
    if (session.ttsPaused) return;
    session.ttsPaused = true;
    session.ttsPausedAt = this.now();
    const onset = session.voiceOnsetAt ?? this.now();
    const queuedUntil = pending.lastAudioEndsAt ?? this.now();
    const remainingMs = Math.max(0, Math.round(queuedUntil - this.now()));
    this.options.onSpeechPause?.(session.sessionId, { ...pending.trace, playedMs: this.playedMs(pending),
      latencyMs: Math.max(0, Math.round(Math.max(this.now(), queuedUntil) - onset)), remainingMs });
  }

  /** Resume after the sound: quickly when recognition heard no speech in it, else after the backchannel window. */
  private armResume(session: RealtimeSession): void {
    if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
    const heard = session.pauseHeardSpeech === true;
    session.ttsPauseTimer = setTimeout(() => this.resumeSpeech(session, heard ? 'timeout' : 'quiet'),
      heard ? BACKCHANNEL_PAUSE_MAX_MS : QUIET_RESUME_MS);
    session.ttsPauseTimer.unref?.();
  }

  private resumeSpeech(session: RealtimeSession, cause: 'backchannel' | 'quiet' | 'timeout'): void {
    if (!session.ttsPaused) return;
    session.ttsPaused = false;
    if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
    session.ttsPauseTimer = undefined;
    const pausedAt = session.ttsPausedAt ?? this.now();
    session.ttsPausedAt = undefined;
    if (session.ttsPending) this.options.onSpeechResume?.(session.sessionId, {
      ...session.ttsPending.trace, cause, pausedMs: Math.max(0, Math.round(this.now() - pausedAt)),
    });
    this.drainAttendeeAudio(session);
  }

  /** Milliseconds of this speak() call's audio heard so far: sent at playback pace, never more than was sent. */
  private playedMs(pending: NonNullable<RealtimeSession['ttsPending']>): number {
    return pending.firstAudioAt === undefined ? 0 : Math.round(Math.min(pending.sentMs, this.now() - pending.firstAudioAt));
  }

  private warmTts(session: RealtimeSession): void {
    if (!this.options.warmSpeech || session.closed || session.attendeeSocket?.readyState !== WebSocket.OPEN) return;
    void this.openTts(session).catch(() => undefined);
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    session.attendeeSocket?.close(1000, 'meeting ended');
    this.closeProviderSockets(session);
    this.sessions.delete(sessionId);
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const sessionId of this.sessions.keys()) this.closeSession(sessionId);
    this.wss.close();
  }

  private onAttendeeMessage(sessionId: string, session: RealtimeSession, data: RawData): void {
    if (!session.botId) {
      try {
        const early = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof early.bot_id === 'string' && /^bot_[a-zA-Z0-9_-]+$/.test(early.bot_id)) {
          if (session.observedBotId && session.observedBotId !== early.bot_id) return;
          session.observedBotId = early.bot_id;
          if (session.pendingFrames.length >= MAX_PENDING_FRAMES) return;
          session.pendingFrames.push(early);
          if (session.recoverOnFirstFrame && !session.authorizingBot) {
            if (!this.options.authorizeRecoveredBot) {
              session.attendeeSocket?.close(1008, 'recovery authorization unavailable');
              this.closeSession(sessionId);
              return;
            }
            session.authorizingBot = early.bot_id;
            void this.options.authorizeRecoveredBot(sessionId, early.bot_id).then(authorized => {
              if (this.sessions.get(sessionId) !== session || session.closed) return;
              if (!authorized || session.observedBotId !== early.bot_id) {
                session.attendeeSocket?.close(1008, 'unrecognized bot');
                this.closeSession(sessionId);
                return;
              }
              session.recoverOnFirstFrame = false;
              if (!session.botId) session.botId = early.bot_id as string;
              for (const frame of session.pendingFrames.splice(0)) this.processAttendeeFrame(sessionId, session, frame);
            }).catch(() => {
              this.options.onError?.('attendee_audio_session_recovery_failed');
              session.attendeeSocket?.close(1011, 'session recovery failed');
              this.closeSession(sessionId);
            });
          }
        }
      } catch { /* Ignore malformed pre-bind frames. */ }
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(data.toString()) as unknown; } catch { return; }
    this.processAttendeeFrame(sessionId, session, payload);
  }

  private processAttendeeFrame(sessionId: string, session: RealtimeSession, payload: unknown): void {
    const frame = parseAttendeeAudioFrame(payload, session.botId);
    if (!frame) return;
    let speaker = session.speakers.get(frame.participantUuid);
    if (!speaker) {
      if (session.speakers.size >= MAX_PARTICIPANTS_PER_SESSION) return;
      speaker = this.openSpeaker(sessionId, session, frame.participantUuid);
      session.speakers.set(frame.participantUuid, speaker);
    }
    speaker.lastAudioAt = this.now();
    this.trackVoiceLevel(session, speaker, frame.audio, frame.participantUuid);
    this.watchForMute(speaker);
    if (speaker.socket.readyState === WebSocket.OPEN) {
      if (speaker.socket.bufferedAmount > 1_000_000) {
        this.closeSpeaker(session, frame.participantUuid, speaker);
        return;
      }
      speaker.socket.send(frame.audio, { binary: true });
      this.options.onUsage?.(sessionId, { sttBytes: frame.audio.length });
    } else if (speaker.pendingAudio.reduce((bytes, audio) => bytes + audio.length, 0) + frame.audio.length <= MAX_PENDING_SPEAKER_BYTES) {
      speaker.pendingAudio.push(frame.audio);
    } else {
      this.closeSpeaker(session, frame.participantUuid, speaker);
    }
  }

  /**
   * Background talk on an open microphone (an office, a cafe) is transcribed like anyone else's words. The voice
   * lab showed it interrupting every answer. Only speech near this participant's own speaking level (and near the
   * room's loudest speaker) may interrupt Nogita; transcripts are still delivered either way.
   */
  private trackVoiceLevel(session: RealtimeSession, speaker: SpeakerStream, audio: Buffer, participantUuid: string): void {
    let sum = 0;
    const samples = audio.length >> 1;
    for (let i = 0; i < samples; i++) { const v = audio.readInt16LE(i * 2) / 32768; sum += v * v; }
    const level = Math.sqrt(sum / Math.max(1, samples));
    const frameMs = samples * 1000 / AUDIO_SAMPLE_RATE;
    // Quiet level starts low (-50 dBFS), follows dips at once and rises slowly (about 6 dB per second),
    // so a first word is never mistaken for the room's background.
    const floor = speaker.noiseFloor ?? 0.003;
    speaker.noiseFloor = level < floor ? Math.max(level, 1e-5) : floor * 2 ** (frameMs / 1000);
    if (level < speaker.noiseFloor * 4) {
      // Speech contains short unvoiced valleys. Decay the run instead of resetting it at once, otherwise the
      // onset clock restarts inside a word and the measured interruption budget begins hundreds of ms late.
      speaker.loudRunMs = Math.max(0, speaker.loudRunMs - frameMs / 2);
      if (speaker.loudRunMs === 0 && session.voiceOnsetParticipant === participantUuid) {
        session.voiceOnsetAt = undefined;
        session.voiceOnsetParticipant = undefined;
      }
      return;
    }
    // The speaker's own level fades over minutes (about 10% a minute), not seconds: with a fast fade, nearby
    // talk ten seconds after they stopped became "their" voice and cut Nogita off.
    speaker.speechPeak = Math.max(level, speaker.speechPeak * 0.999998 ** frameMs);
    // Own speech uses the selected rollout profile. V2 accepts a quieter second utterance after a loud first one
    // (about 9 dB / 80 ms); legacy rollback keeps the prior 6 dB / 100 ms gate.
    // Before someone has spoken, background talk on their microphone is the loudest thing it hears and sets their
    // level; the room's loudest speaker keeps that talk from counting (it must also be within 12 dB of them).
    session.voicePeak = Math.max(speaker.speechPeak, session.voicePeak * 0.999998 ** frameMs);
    const own = level >= speaker.speechPeak * this.turnTaking.ownVoicePeakRatio && level >= session.voicePeak * 0.25;
    if (own && speaker.lastOwnVoiceAt !== undefined && this.now() - speaker.lastOwnVoiceAt > VOICE_RUN_GRACE_MS) {
      speaker.loudRunMs = 0;
      if (session.voiceOnsetParticipant === participantUuid) {
        session.voiceOnsetAt = undefined;
        session.voiceOnsetParticipant = undefined;
      }
    }
    if (own) speaker.lastOwnVoiceAt = this.now();
    if (own) this.options.onInputLevel?.(session.sessionId, level);
    if (own && speaker.loudRunMs === 0) {
      session.voiceOnsetAt = this.now() - frameMs;
      session.voiceOnsetParticipant = participantUuid;
    }
    speaker.loudRunMs = own ? speaker.loudRunMs + frameMs : Math.max(0, speaker.loudRunMs - frameMs / 2);
    if (!own && speaker.loudRunMs === 0 && session.voiceOnsetParticipant === participantUuid) {
      session.voiceOnsetAt = undefined;
      session.voiceOnsetParticipant = undefined;
    }
    if (speaker.loudRunMs >= this.turnTaking.ownVoiceGateMs) {
      // Recognition results trail the audio, so speech vouches for the next 1.5 s of results.
      speaker.loudUntil = this.now() + 1_500;
      if (own && this.now() - speaker.lastVoiceSignalAt >= 200) {
        speaker.lastVoiceSignalAt = this.now();
        this.options.onVoice?.(session.sessionId, participantUuid);
      }
      if (own && this.turnTaking.pauseAndClassify) this.pauseSpeech(session);
      // The output has already stopped within the 300 ms acceptance budget. Keep its queue recoverable long
      // enough for interim STT to distinguish an acknowledgement; abandon it if recognition never arrives.
      if (own && this.turnTaking.pauseAndClassify && session.voiceOnsetAt !== undefined &&
          this.now() - session.voiceOnsetAt >= BARGE_IN_CANCEL_MS) {
        this.interruptSpeech(session.sessionId, 'voice');
      }
    }
  }

  /**
   * People mute right after they speak. Without more audio the recognizer never decides the turn is over and
   * the words are lost (found by the voice lab), so after 200 ms without frames the hub feeds it up to three
   * seconds of silence.
   */
  private watchForMute(speaker: SpeakerStream): void {
    if (speaker.silencePump) { clearInterval(speaker.silencePump); speaker.silencePump = undefined; }
    if (speaker.quietTimer) clearTimeout(speaker.quietTimer);
    speaker.quietTimer = setTimeout(() => {
      speaker.quietTimer = undefined;
      let sentMs = 0;
      speaker.silencePump = setInterval(() => {
        if (speaker.socket.readyState === WebSocket.OPEN) speaker.socket.send(Buffer.alloc(3_200), { binary: true });
        if ((sentMs += 100) >= 3_000 && speaker.silencePump) { clearInterval(speaker.silencePump); speaker.silencePump = undefined; }
      }, 100);
      speaker.silencePump.unref?.();
    }, 200);
    speaker.quietTimer.unref?.();
  }

  private openSpeaker(sessionId: string, session: RealtimeSession, participantUuid: string): SpeakerStream {
    const flux = this.options.sttMode === 'flux-english';
    const url = new URL(flux ? 'wss://api.deepgram.com/v2/listen' : 'wss://api.deepgram.com/v1/listen');
    if (flux) {
      for (const [key, value] of Object.entries({ model: 'flux-general-en', encoding: 'linear16',
        sample_rate: String(AUDIO_SAMPLE_RATE), eot_threshold: String(this.options.fluxEndOfTurnThreshold ?? 0.8),
        eot_timeout_ms: '3000' })) {
        url.searchParams.set(key, value);
      }
      if (this.options.fluxEagerEndOfTurnThreshold !== undefined) {
        url.searchParams.set('eager_eot_threshold', String(this.options.fluxEagerEndOfTurnThreshold));
      }
    } else {
      for (const [key, value] of Object.entries({ model: 'nova-3', language: 'multi',
        encoding: 'linear16', sample_rate: String(AUDIO_SAMPLE_RATE), channels: '1', interim_results: 'true',
        endpointing: '500', utterance_end_ms: '1000', smart_format: 'true' })) url.searchParams.set(key, value);
      // Hints bias detection toward the team's languages without restricting it (English by default).
      for (const language of this.options.languages ?? DEFAULT_LANGUAGES) url.searchParams.append('language_hint', language);
    }
    if (this.options.deepgramMipOptOut !== false) url.searchParams.set('mip_opt_out', 'true');
    // Without a keyterm, Nova-3 and Flux hear the wake word as "Nokita", "Notita" or "Nikita".
    for (const term of new Set(['Nogita', ...(this.options.keyterms ?? [])])) url.searchParams.append('keyterm', term);
    const speaker: SpeakerStream = { inputTurnId: randomUUID(), socket: this.createWebSocket(url.toString(), {
      headers: { Authorization: `Token ${this.options.deepgramApiKey}` }, perMessageDeflate: false,
    }), pendingAudio: [], finalSegments: [], confidences: [], lastAudioAt: this.now(), speechPeak: 0, loudUntil: 0, loudRunMs: 0, lastVoiceSignalAt: 0 };
    const deliverTurn = (turn: string) => {
      if (this.turnTaking.pauseAndClassify && isBackchannel(turn)) this.resumeSpeech(session, 'backchannel');
      else if (this.now() <= speaker.loudUntil) this.interruptSpeech(sessionId, 'voice');
      speaker.lastTurnText = turn;
      speaker.lastTurnAt = this.now();
      const scores = speaker.confidences.splice(0);
      const recognition = scores.length
        ? { confidence: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 1000) / 1000 } : {};
      void Promise.resolve(this.options.onTranscript(sessionId, participantUuid, turn,
        session.participantIdentity.get(participantUuid), { ...recognition, inputTurnId: speaker.inputTurnId }))
      .catch(() => this.options.onError?.('attendee_transcript_processing_failed'));
    };
    speaker.socket.on('open', () => {
      // A new stream usually starts with someone's first words (they just unmuted). Flux missed the opening
      // "Nogita" when audio began at once; half a second of silence first lets it settle.
      if (speaker.socket.readyState === WebSocket.OPEN) speaker.socket.send(Buffer.alloc(AUDIO_SAMPLE_RATE), { binary: true });
      for (const audio of speaker.pendingAudio.splice(0)) {
        if (speaker.socket.readyState !== WebSocket.OPEN) break;
        speaker.socket.send(audio, { binary: true });
        this.options.onUsage?.(session.sessionId, { sttBytes: audio.length });
      }
    });
    speaker.socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: unknown;
      try { message = JSON.parse(data.toString()) as unknown; } catch { return; }
      const ownVoice = this.now() <= speaker.loudUntil;
      if (flux ? hasFluxSpeechActivity(message) : hasNova3SpeechActivity(message)) {
        const interim = liveTranscript(message);
        if (interim) this.options.onInterim?.(sessionId, participantUuid, interim);
        // Recognition hears speech in the pause: wait for its words before resuming ("yeah" or an interruption).
        if (session.ttsPaused && !session.pauseHeardSpeech) { session.pauseHeardSpeech = true; this.armResume(session); }
        if (ownVoice) {
          // Flux first emits a wordless StartOfTurn. V2 has already paused output and waits for a hypothesis so a
          // backchannel can resume; the legacy profile keeps transcript-driven immediate interruption.
          if (this.turnTaking.pauseAndClassify) {
            if (interim && isBackchannel(interim)) this.resumeSpeech(session, 'backchannel');
            else if (interim) this.interruptSpeech(sessionId, 'voice');
          } else {
            this.interruptSpeech(sessionId, 'voice');
          }
          this.options.onSpeechActivity?.(sessionId, participantUuid);
        }
      }
      if (flux) {
        const info = message as { type?: string; event?: string; transcript?: unknown };
        const phase = info.event === 'EagerEndOfTurn' ? 'eager' : info.event === 'EndOfTurn' ? 'confirmed'
          : info.event === 'TurnResumed' ? 'resumed' : undefined;
        if (info.type === 'TurnInfo' && phase) {
          this.options.onTurnTiming?.(sessionId, participantUuid, { phase, inputTurnId: speaker.inputTurnId,
            ...(speaker.lastOwnVoiceAt !== undefined ? { sinceLastVoiceMs: Math.max(0, this.now() - speaker.lastOwnVoiceAt) } : {}) });
          if (phase === 'confirmed') speaker.lastOwnVoiceAt = undefined;
        }
        if (info.type === 'TurnInfo' && info.event === 'EagerEndOfTurn' && typeof info.transcript === 'string' && info.transcript.trim()) {
          this.options.onEagerTranscript?.(sessionId, participantUuid, info.transcript.trim().slice(0, 4000),
            session.participantIdentity.get(participantUuid), speaker.inputTurnId);
        } else if (info.type === 'TurnInfo' && info.event === 'TurnResumed') {
          this.options.onTurnResumed?.(sessionId, participantUuid);
        }
      }
      const score = finalConfidence(message);
      if (score !== undefined) { speaker.confidences.push(score); if (speaker.confidences.length > 24) speaker.confidences.shift(); }
      const turn = assembleNova3Turn(message, speaker.finalSegments);
      if (turn && !(speaker.lastTurnText === turn && this.now() - (speaker.lastTurnAt ?? 0) < 2_000)) deliverTurn(turn);
      if (turn) speaker.inputTurnId = randomUUID();
    });
    speaker.socket.on('error', () => this.options.onError?.('deepgram_listen_socket_error'));
    speaker.socket.on('close', () => {
      if (session.speakers.get(participantUuid) === speaker) session.speakers.delete(participantUuid);
    });
    return speaker;
  }

  private async openTts(session: RealtimeSession): Promise<WebSocket> {
    if (session.ttsSocket?.readyState === WebSocket.OPEN) return session.ttsSocket;
    if (session.ttsOpening) return session.ttsOpening;
    const url = new URL('wss://api.deepgram.com/v1/speak');
    url.searchParams.set('model', this.options.ttsModel ?? 'aura-2-thalia-en');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(AUDIO_SAMPLE_RATE));
    if (this.options.deepgramMipOptOut !== false) url.searchParams.set('mip_opt_out', 'true');
    const opening = new Promise<WebSocket>((resolve, reject) => {
      const tts = this.createWebSocket(url.toString(), {
        headers: { Authorization: `Token ${this.options.deepgramApiKey}` }, perMessageDeflate: false,
      });
      session.ttsSocket = tts;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        tts.close(1013, 'TTS connection timed out');
        reject(new Error('Deepgram TTS connection timed out'));
      }, 10_000);
      let opened = false;
      tts.once('open', () => {
        if (settled) { tts.close(1013, 'late TTS connection'); return; }
        settled = true;
        opened = true;
        clearTimeout(timeout);
        resolve(tts);
      });
      tts.on('message', (data, isBinary) => {
        if (session.ttsSocket !== tts) return;
        if (isBinary) {
          const pending = session.ttsPending;
          const attendee = session.attendeeSocket;
          if (!pending || !attendee || attendee.readyState !== WebSocket.OPEN) return;
          const audio = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          pending.bytes += audio.length;
          if (pending.bytes > MAX_TTS_TURN_BYTES || attendee.bufferedAmount > 1_000_000) {
            pending.reject(new Error('realtime audio output limit exceeded'));
            tts.close(1013, 'audio output limit exceeded');
            return;
          }
          let carry = Buffer.concat([session.ttsCarry ?? Buffer.alloc(0), audio]);
          while (carry.length >= 3_200) {
            session.ttsQueue.push(Buffer.from(carry.subarray(0, 3_200)));
            carry = carry.subarray(3_200);
          }
          session.ttsCarry = carry;
          this.drainAttendeeAudio(session);
          return;
        }
        let message: Record<string, unknown>;
        try { message = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        if (message.type === 'Flushed' && session.ttsPending) {
          const carry = session.ttsCarry ?? Buffer.alloc(0);
          if (carry.length > 0 && carry.length % 2 !== 0) {
            session.ttsPending.reject(new Error('Deepgram TTS returned invalid PCM audio'));
            return;
          }
          if (carry.length > 0) session.ttsQueue.push(Buffer.from(carry));
          session.ttsCarry = Buffer.alloc(0);
          session.ttsFlushed = true;
          session.ttsPending.synthesisComplete();
          this.drainAttendeeAudio(session);
        } else if ((message.type === 'Warning' || message.type === 'Error') && session.ttsPending) {
          session.ttsPending.reject(new Error('Deepgram TTS reported an error'));
        }
      });
      tts.on('error', () => {
        clearTimeout(timeout);
        settled = true;
        reject(new Error('Deepgram TTS connection failed'));
        if (session.ttsSocket === tts) session.ttsPending?.reject(new Error('Deepgram TTS connection failed'));
      });
      tts.on('close', () => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error('Deepgram TTS connection closed')); }
        if (session.ttsSocket === tts) {
          session.ttsSocket = undefined;
          if (!session.ttsFlushed) session.ttsPending?.reject(new Error('Deepgram TTS connection closed'));
          // The provider closed an idle connection: open the next one now rather than when she next speaks.
          // A connection that never opened is not retried here, so a bad key cannot loop.
          if (opened) setTimeout(() => this.warmTts(session), 1_000).unref?.();
        }
      });
    }).finally(() => { session.ttsOpening = undefined; });
    session.ttsOpening = opening;
    return opening;
  }

  private closeSpeaker(session: RealtimeSession, participantUuid: string, speaker: SpeakerStream): void {
    session.speakers.delete(participantUuid);
    if (speaker.quietTimer) clearTimeout(speaker.quietTimer);
    if (speaker.silencePump) clearInterval(speaker.silencePump);
    speaker.pendingAudio.length = 0;
    speaker.socket.close(1000, 'speaker stream ended');
  }

  private sendAttendeeAudio(attendee: WebSocket, audio: Buffer): void {
    if (audio.length % 2 !== 0 || audio.length > MAX_ATTENDEE_FRAME_BYTES || attendee.bufferedAmount > 1_000_000) {
      throw new Error('invalid or backpressured Attendee audio output');
    }
    attendee.send(JSON.stringify({ trigger: 'realtime_audio.bot_output', data: {
      chunk: audio.toString('base64'), sample_rate: AUDIO_SAMPLE_RATE,
    } }));
  }

  private drainAttendeeAudio(session: RealtimeSession): void {
    if (session.ttsTimer || session.ttsPaused || !session.ttsPending) return;
    const audio = session.ttsQueue.shift();
    if (!audio) {
      if (session.ttsFlushed) session.ttsPending.resolve();
      return;
    }
    const attendee = session.attendeeSocket;
    if (!attendee || attendee.readyState !== WebSocket.OPEN) {
      session.ttsPending.reject(new Error('Attendee audio output disconnected'));
      return;
    }
    try { this.sendAttendeeAudio(attendee, audio); }
    catch {
      session.ttsPending.reject(new Error('Attendee audio output failed'));
      return;
    }
    this.options.onOutputAudio?.(session.sessionId, audio, session.ttsPending.trace);
    // Pace PCM near playback time so an interruption can discard audio still queued locally.
    const durationMs = audio.length / (AUDIO_SAMPLE_RATE * 2) * 1000;
    if (session.ttsPending.firstAudioAt === undefined) {
      session.ttsPending.firstAudioAt = this.now();
      this.options.onSpeechStart?.(session.sessionId, { ...session.ttsPending.trace,
        ttfaMs: Math.max(0, this.now() - session.ttsPending.requestedAt) });
    }
    session.ttsPending.sentMs += durationMs;
    // Timer callbacks can run late. The end of the frame that was actually just sent is more accurate than
    // firstAudioAt + ideal accumulated duration when reporting when the meeting will become quiet.
    session.ttsPending.lastAudioEndsAt = this.now() + durationMs;
    session.ttsTimer = setTimeout(() => {
      session.ttsTimer = undefined;
      this.drainAttendeeAudio(session);
    }, durationMs);
  }

  private closeProviderSockets(session: RealtimeSession): void {
    session.speechPreparation?.abort.abort(new Error('realtime audio session closed'));
    session.speechPreparation = undefined;
    for (const [participantUuid, speaker] of session.speakers) this.closeSpeaker(session, participantUuid, speaker);
    session.ttsPending?.reject(new Error('realtime audio session closed'));
    session.ttsPending = undefined;
    if (session.ttsPauseTimer) clearTimeout(session.ttsPauseTimer);
    session.ttsPauseTimer = undefined;
    session.ttsPaused = false;
    session.ttsPausedAt = undefined;
    session.ttsCarry = Buffer.alloc(0);
    session.ttsSocket?.close(1000, 'meeting stream ended');
    session.ttsSocket = undefined;
  }

  private closeIdleSpeakers(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      for (const [participantUuid, speaker] of session.speakers) {
        if (now - speaker.lastAudioAt >= DEEPGRAM_IDLE_MS && speaker.pendingAudio.length === 0) {
          this.closeSpeaker(session, participantUuid, speaker);
        }
      }
    }
  }

  private newSession(sessionId: string): RealtimeSession {
    return { sessionId, pendingFrames: [], speakers: new Map(), participantIdentity: new Map(),
      ttsQueue: [], ttsFlushed: false, ttsPaused: false, closed: false, voicePeak: 0 };
  }
}

/** Confidence of a final Nova-3 result, if it carries words. */
export function finalConfidence(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const result = message as { is_final?: unknown; channel?: { alternatives?: Array<{ transcript?: unknown; confidence?: unknown }> } };
  const first = result.is_final === true ? result.channel?.alternatives?.[0] : undefined;
  return first && typeof first.confidence === 'number' && typeof first.transcript === 'string' && first.transcript.trim()
    ? first.confidence : undefined;
}

export function hasNova3SpeechActivity(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const result = message as Record<string, unknown>;
  if (result.speech_final === true) return false;
  const channel = result.channel;
  const alternatives = channel && typeof channel === 'object'
    ? (channel as Record<string, unknown>).alternatives : undefined;
  const first = Array.isArray(alternatives) ? alternatives[0] : undefined;
  return !!first && typeof first === 'object' && typeof (first as Record<string, unknown>).transcript === 'string'
    && ((first as Record<string, unknown>).transcript as string).trim().length > 0;
}

/** The words of a live recognition result (Flux TurnInfo or a Nova-3 result), if any. */
export function liveTranscript(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const result = message as Record<string, unknown>;
  if (typeof result.transcript === 'string') return result.transcript.trim() || undefined;
  const channel = result.channel;
  const alternatives = channel && typeof channel === 'object' ? (channel as Record<string, unknown>).alternatives : undefined;
  const first = Array.isArray(alternatives) ? alternatives[0] as Record<string, unknown> | undefined : undefined;
  return typeof first?.transcript === 'string' ? first.transcript.trim() || undefined : undefined;
}

/** Short listener acknowledgements should not seize the floor from an answer already playing. */
export function isBackchannel(text: string): boolean {
  const normalized = text.toLowerCase().replace(/-/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:yeah|yep|yes|right|ok(?:ay)?|sure|got it|i see|m+h+m+|m+ h+m+|u+h+ h+u+h+|h+m+)$/.test(normalized);
}

export function hasFluxSpeechActivity(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const turn = message as Record<string, unknown>;
  return turn.type === 'TurnInfo' && (turn.event === 'StartOfTurn' || turn.event === 'TurnResumed' ||
    (turn.event === 'Update' && typeof turn.transcript === 'string' && !!turn.transcript.trim()));
}
