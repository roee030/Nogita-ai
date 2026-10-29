import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

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
  sttMode?: 'nova3-multilingual' | 'flux-english';
  ttsModel?: string;
  /** Flux end-of-turn confidence. Deepgram's default 0.7 ended turns at the pause after "Nogita," in the voice lab,
   *  so she answered her own name and was cut off by the rest of the question; 0.8 waits for the question. */
  fluxEndOfTurnThreshold?: number;
  /** Keep a speech connection open for the whole meeting: a cold one cost 0.7-1.4 s before the first word. */
  warmSpeech?: boolean;
  /** Words the recognizer should expect (Deepgram keyterm prompting); always includes the wake word. */
  keyterms?: readonly string[];
  /** Synthesis watchdog; playback may continue after Deepgram confirms Flush. */
  ttsSynthesisTimeoutMs?: number;
  onTranscript: (sessionId: string, participantUuid: string, transcript: string,
    identity?: { attendeeUserUuid?: string; displayName?: string }) => void | Promise<void>;
  onSpeechActivity?: (sessionId: string, participantUuid: string) => void;
  onUsage?: (sessionId: string, usage: { sttBytes?: number; ttsCharacters?: number }) => void;
  authorizeRecoveredBot?: (sessionId: string, botId: string) => Promise<boolean>;
  onError?: (code: string) => void;
  now?: () => number;
  createWebSocket?: (url: string, options: { headers: Record<string, string>; perMessageDeflate: false }) => WebSocket;
}

interface SpeakerStream {
  socket: WebSocket;
  pendingAudio: Buffer[];
  finalSegments: string[];
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
  ttsPending?: { resolve: () => void; reject: (error: Error) => void;
    synthesisComplete: () => void; bytes: number };
  ttsCarry?: Buffer;
  ttsQueue: Buffer[];
  ttsFlushed: boolean;
  /** Loudest speaking level heard from anyone in the meeting (the own-voice gate's room reference). */
  voicePeak: number;
  ttsTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class AttendeeRealtimeAudioHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 100_000, perMessageDeflate: false });
  private readonly sessions = new Map<string, RealtimeSession>();
  private readonly now: () => number;
  private readonly createWebSocket: NonNullable<RealtimeAudioOptions['createWebSocket']>;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RealtimeAudioOptions) {
    if (!options.signingSecret.trim() || !options.deepgramApiKey.trim()) throw new Error('realtime audio credentials are required');
    if (options.ttsModel && !/^aura-2-[a-z]+-en$/.test(options.ttsModel)) {
      throw new Error('unsupported Deepgram TTS model');
    }
    // Validate the origin and fixed route once at startup.
    createAttendeeAudioSocketUrl(options.baseUrl, options.signingSecret, 'configuration-check');
    this.now = options.now ?? Date.now;
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
        if (session.attendeeSocket === client) session.attendeeSocket = undefined;
        this.closeProviderSockets(session);
      });
      client.on('error', () => this.options.onError?.('attendee_audio_socket_error'));
      this.warmTts(session);
    });
    return true;
  }

  async speak(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.attendeeSocket?.readyState !== WebSocket.OPEN || !session.botId) {
      throw new Error('Attendee realtime audio is not connected');
    }
    if (!text.trim() || text.length > 2000) throw new Error('invalid realtime speech text');
    if (session.ttsPending) throw new Error('realtime speech is already in progress');
    const tts = await this.openTts(session);
    await new Promise<void>((resolve, reject) => {
      let pending!: NonNullable<RealtimeSession['ttsPending']>;
      const timeout = setTimeout(() => {
        if (session.ttsPending !== pending) return;
        pending.reject(new Error('Deepgram TTS timed out'));
      }, this.options.ttsSynthesisTimeoutMs ?? 20_000);
      const settle = (error?: Error) => {
        clearTimeout(timeout);
        if (session.ttsPending === pending) {
          session.ttsPending = undefined;
          session.ttsQueue.length = 0;
          session.ttsFlushed = false;
          if (session.ttsTimer) clearTimeout(session.ttsTimer);
          session.ttsTimer = undefined;
        }
        if (error) reject(error); else resolve();
      };
      pending = { resolve: () => settle(), reject: settle,
        synthesisComplete: () => clearTimeout(timeout), bytes: 0 };
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

  /** Stop synthesizing and forwarding this turn when a human starts a new turn. */
  interruptSpeech(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const pending = session?.ttsPending;
    if (!session || !pending) return false;
    session.ttsCarry = Buffer.alloc(0);
    const interruptedSocket = session.ttsSocket;
    // A late Flushed or audio frame belongs to the old turn, never the next one.
    session.ttsSocket = undefined;
    if (interruptedSocket?.readyState === WebSocket.OPEN) {
      try { interruptedSocket.send(JSON.stringify({ type: 'Clear' })); }
      catch { this.options.onError?.('deepgram_tts_clear_failed'); }
    }
    pending.reject(new Error('speech interrupted by participant'));
    interruptedSocket?.close(1000, 'speech interrupted');
    // The answer to whoever interrupted should not wait for a new handshake.
    this.warmTts(session);
    return true;
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
    this.trackVoiceLevel(session, speaker, frame.audio);
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
  private trackVoiceLevel(session: RealtimeSession, speaker: SpeakerStream, audio: Buffer): void {
    let sum = 0;
    const samples = audio.length >> 1;
    for (let i = 0; i < samples; i++) { const v = audio.readInt16LE(i * 2) / 32768; sum += v * v; }
    const level = Math.sqrt(sum / Math.max(1, samples));
    const frameMs = samples * 1000 / AUDIO_SAMPLE_RATE;
    // Quiet level starts low (-50 dBFS), follows dips at once and rises slowly (about 6 dB per second),
    // so a first word is never mistaken for the room's background.
    const floor = speaker.noiseFloor ?? 0.003;
    speaker.noiseFloor = level < floor ? Math.max(level, 1e-5) : floor * 2 ** (frameMs / 1000);
    if (level < speaker.noiseFloor * 4) return;
    // The speaker's own level fades over minutes (about 10% a minute), not seconds: with a fast fade, nearby
    // talk ten seconds after they stopped became "their" voice and cut Nogita off.
    speaker.speechPeak = Math.max(level, speaker.speechPeak * 0.999998 ** frameMs);
    // Own speech: at least 100 ms within 6 dB of the speaker's level. Single loud syllables of nearby talk at
    // -15 dB still passed a one-frame, 10 dB gate and cut Nogita off in the office scenario.
    // Before someone has spoken, background talk on their microphone is the loudest thing it hears and sets their
    // level; the room's loudest speaker keeps that talk from counting (it must also be within 12 dB of them).
    session.voicePeak = Math.max(speaker.speechPeak, session.voicePeak * 0.999998 ** frameMs);
    const own = level >= speaker.speechPeak * 0.5 && level >= session.voicePeak * 0.25;
    speaker.loudRunMs = own ? speaker.loudRunMs + frameMs : Math.max(0, speaker.loudRunMs - frameMs / 2);
    if (speaker.loudRunMs >= 100) {
      // Recognition results trail the audio, so speech vouches for the next 1.5 s of results.
      speaker.loudUntil = this.now() + 1_500;
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
    } else {
      for (const [key, value] of Object.entries({ model: 'nova-3', language: 'multi', language_hint: 'en',
        encoding: 'linear16', sample_rate: String(AUDIO_SAMPLE_RATE), channels: '1', interim_results: 'true',
        endpointing: '500', utterance_end_ms: '1000', smart_format: 'true' })) url.searchParams.set(key, value);
      url.searchParams.append('language_hint', 'he');
    }
    // Without a keyterm, Nova-3 and Flux hear the wake word as "Nokita", "Notita" or "Nikita".
    for (const term of new Set(['Nogita', ...(this.options.keyterms ?? [])])) url.searchParams.append('keyterm', term);
    const speaker: SpeakerStream = { socket: this.createWebSocket(url.toString(), {
      headers: { Authorization: `Token ${this.options.deepgramApiKey}` }, perMessageDeflate: false,
    }), pendingAudio: [], finalSegments: [], lastAudioAt: this.now(), speechPeak: 0, loudUntil: 0, loudRunMs: 0 };
    const deliverTurn = (turn: string) => {
      if (this.now() <= speaker.loudUntil) this.interruptSpeech(sessionId);
      speaker.lastTurnText = turn;
      speaker.lastTurnAt = this.now();
      void Promise.resolve(this.options.onTranscript(sessionId, participantUuid, turn,
        session.participantIdentity.get(participantUuid)))
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
        if (ownVoice) {
          this.interruptSpeech(sessionId);
          this.options.onSpeechActivity?.(sessionId, participantUuid);
        }
      }
      const turn = assembleNova3Turn(message, speaker.finalSegments);
      if (turn && !(speaker.lastTurnText === turn && this.now() - (speaker.lastTurnAt ?? 0) < 2_000)) deliverTurn(turn);
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
    if (session.ttsTimer || !session.ttsPending) return;
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
    // Pace PCM near playback time so an interruption can discard audio still queued locally.
    const durationMs = audio.length / (AUDIO_SAMPLE_RATE * 2) * 1000;
    session.ttsTimer = setTimeout(() => {
      session.ttsTimer = undefined;
      this.drainAttendeeAudio(session);
    }, durationMs);
  }

  private closeProviderSockets(session: RealtimeSession): void {
    for (const [participantUuid, speaker] of session.speakers) this.closeSpeaker(session, participantUuid, speaker);
    session.ttsPending?.reject(new Error('realtime audio session closed'));
    session.ttsPending = undefined;
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
      ttsQueue: [], ttsFlushed: false, closed: false, voicePeak: 0 };
  }
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

export function hasFluxSpeechActivity(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const turn = message as Record<string, unknown>;
  return turn.type === 'TurnInfo' && (turn.event === 'StartOfTurn' || turn.event === 'TurnResumed' ||
    (turn.event === 'Update' && typeof turn.transcript === 'string' && !!turn.transcript.trim()));
}
