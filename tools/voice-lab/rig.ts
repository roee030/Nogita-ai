/**
 * A meeting without a meeting: the production voice path (AttendeeRealtimeAudioHub -> Deepgram STT ->
 * AttendeeCommandRouter -> NogitaEngine -> Deepgram TTS -> hub output) runs locally, and the lab plays
 * Attendee: it streams each participant's microphone in real time over the same signed WebSocket and
 * receives Nogita's audio back. Every step is timestamped on one clock (performance.now()).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { AttendeeRealtimeAudioHub, type RealtimeAudioOptions } from '../../src/app/attendee-realtime-audio.ts';
import { AttendeeCommandRouter } from '../../src/app/attendee-command-router.ts';
import { NogitaEngine, type NogitaEngineOptions, type Speculation } from '../../src/core/engine.ts';
import type { ActionReceipt, Actor, Capability, MeetingPort, SpeakOptions, Utterance } from '../../src/core/contracts.ts';
import { FRAME_SAMPLES, SAMPLE_RATE, Track, floatToPcm, msToSamples, pcmToFloat } from './audio.ts';
import type { NoiseSource } from './noise.ts';

export type LabEventType =
  | 'speech_start' | 'speech_end' | 'mic_on' | 'mic_off'
  | 'stt_activity' | 'stt_final' | 'utterance' | 'engine_done' | 'engine_error'
  | 'speak_call' | 'speak_done' | 'speak_error' | 'chat'
  | 'audio_start' | 'audio_stop' | 'write' | 'tool' | 'error'
  /** Flux early end-of-turn (an answer may start speculatively) and the speaker going on after it. */
  | 'stt_eager' | 'stt_resumed'
  /** A question's status changed in the engine (detail: "#id status: note"). */
  | 'question';

export interface LabEvent { t: number; type: LabEventType; participant?: string; text?: string; detail?: string }

type EngineDependencies = ConstructorParameters<typeof NogitaEngine>[0];

export interface RigOptions {
  deepgramApiKey: string;
  sttMode?: 'nova3-multilingual' | 'flux-english';
  ttsModel?: string;
  dependencies: EngineDependencies;
  engineOptions?: NogitaEngineOptions;
  /** Flux end-of-turn threshold; production defaults to 0.8. */
  eotThreshold?: number;
  /** Flux early end-of-turn threshold; unset: no speculative starts. */
  eagerThreshold?: number;
  /** Router quiet window; production uses 1200 ms. */
  routerQuietMs?: number;
  /** Microphone frame length sent to the hub. */
  frameMs?: number;
  /** For offline tests: replaces the Deepgram sockets. */
  createWebSocket?: RealtimeAudioOptions['createWebSocket'];
}

export interface MicParticipant {
  id: string;
  name: string;
  actor: Actor;
  mic: 'open' | 'push';
  noise: NoiseSource;
}

/** Gap in Nogita's received audio that ends one continuous "burst" of her speech. */
const AUDIO_GAP_MS = 250;

class LabMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability> = new Set(['listen', 'speak', 'chat_receipt', 'streaming_speech']);
  speaking = 0;
  constructor(readonly id: string, private readonly rig: VoiceRig) {}
  async join(): Promise<void> {}
  async leave(): Promise<void> {}
  async raiseHand(): Promise<boolean> { return false; }
  async sendCompletion(receipt: ActionReceipt): Promise<void> { await this.sendStatus(`${receipt.label}: ${receipt.url}`); }
  async sendStatus(message: string): Promise<void> { this.rig.log('chat', { text: message }); }
  /** As in production (server.ts gives AttendeeMeeting the hub's interrupt): a "stop" cuts the audio playing now. */
  interruptSpeech(): boolean { return this.rig.hub.interruptSpeech(this.id); }
  /** Same contract as AttendeeMeeting with the realtime bridge: chat mirror unless told otherwise, audio via the hub. */
  async speak(message: string, options: SpeakOptions = {}): Promise<void> {
    this.rig.log('speak_call', { text: message, detail: options.chatMirror === false ? 'no-mirror' : 'mirror' });
    if (options.chatMirror !== false) void this.sendStatus(message);
    this.speaking++;
    try {
      await this.rig.hub.speak(this.id, message);
      this.rig.log('speak_done', { text: message });
    } catch (error) {
      this.rig.log('speak_error', { text: message, detail: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { this.speaking--; }
  }
}

interface MicState {
  participant: MicParticipant;
  uuid: string;
  speech?: { samples: Float32Array; at: number; resolve: (end: number) => void };
  /** Mic sample position until which a push-to-talk mic stays open. */
  openUntil: number;
  on: boolean;
}

export class VoiceRig {
  readonly events: LabEvent[] = [];
  readonly room = new Track();
  readonly nogita = new Track();
  hub!: AttendeeRealtimeAudioHub;
  engine!: NogitaEngine;
  private router!: AttendeeCommandRouter;
  private meeting!: LabMeeting;
  private server?: Server;
  private client?: WebSocket;
  private pump?: ReturnType<typeof setInterval>;
  private mics = new Map<string, MicState>();
  private readonly sessionId = `voice-lab-${randomBytes(4).toString('hex')}`;
  private readonly botId = `bot_voicelab${randomBytes(4).toString('hex')}`;
  private readonly frameSamples: number;
  /** performance.now() of mic sample 0. */
  private t0 = 0;
  private sentFrames = 0;
  private pendingEngine = 0;
  private lastAudioAt = -Infinity;
  private audioPlaying = false;
  private stopped = false;
  private socketCount = 0;

  constructor(private readonly options: RigOptions) {
    this.frameSamples = Math.max(FRAME_SAMPLES, msToSamples(options.frameMs ?? 20));
  }

  log(type: LabEventType, fields: Omit<LabEvent, 't' | 'type'> = {}, t = performance.now()): void {
    this.events.push({ t, type, ...fields });
  }

  /** Mic clock: when a given mic sample was "spoken". */
  micTime(sample: number): number { return this.t0 + sample * 1000 / SAMPLE_RATE; }
  get micPosition(): number { return this.sentFrames * this.frameSamples; }

  async start(participants: MicParticipant[]): Promise<void> {
    const signingSecret = randomBytes(24).toString('base64url');
    const sttMode = this.options.sttMode ?? 'nova3-multilingual';
    const actors = new Map<string, Actor>();
    this.hub = new AttendeeRealtimeAudioHub({
      baseUrl: 'wss://voice-lab.test/webhooks/attendee/audio', signingSecret,
      deepgramApiKey: this.options.deepgramApiKey, sttMode, ttsModel: this.options.ttsModel, warmSpeech: true, fluxEndOfTurnThreshold: this.options.eotThreshold,
      fluxEagerEndOfTurnThreshold: this.options.eagerThreshold,
      createWebSocket: this.options.createWebSocket ?? ((url, options) => {
        // Same socket the hub would open, plus a trace of why a Deepgram stream closed.
        const socket = new WebSocket(url, { ...options, handshakeTimeout: 10_000, maxPayload: 100_000 });
        const kind = url.includes('/speak') ? 'tts' : 'stt';
        socket.on('close', (code, reason) => {
          if (!this.stopped) this.log('error', { detail: `deepgram ${kind} closed ${code} ${reason.toString().slice(0, 120)}` });
        });
        if (process.env.VOICE_LAB_TRACE) {
          const id = ++this.socketCount;
          this.log('error', { detail: `trace ${kind}#${id} open ${url.slice(0, 60)}` });
          let sent = 0;
          let reported = performance.now();
          const send = socket.send.bind(socket);
          socket.send = ((data: Buffer, ...rest: unknown[]) => {
            sent += data.length;
            if (performance.now() - reported > 5_000) {
              reported = performance.now();
              this.log('error', { detail: `trace ${kind}#${id} sent ${Math.round(sent / 1000)} kB state ${socket.readyState} buffered ${socket.bufferedAmount}` });
            }
            return (send as (...args: unknown[]) => void)(data, ...rest);
          }) as typeof socket.send;
          socket.on('message', (data, binary) => {
            if (binary) return;
            const text = data.toString();
            if (text.includes('"Update"')) return;
            try {
              const message = JSON.parse(text) as { type?: string; event?: string; turn_index?: number; transcript?: string };
              this.log('error', { detail: `trace ${kind}#${id} ${message.type} ${message.event ?? ''} ${message.turn_index ?? ''} ${message.transcript ?? ''}` });
            } catch { this.log('error', { detail: `trace ${kind}#${id} ${text.slice(0, 160)}` }); }
          });
        }
        socket.on('unexpected-response', (_request, response) => {
          this.log('error', { detail: `deepgram ${kind} handshake HTTP ${response.statusCode}` });
          socket.terminate();
        });
        return socket;
      }),
      onTranscript: async (sessionId, participantUuid, text) => {
        const actor = actors.get(participantUuid);
        this.log('stt_final', { participant: participantUuid, text });
        if (!actor) return;
        const request = { sessionId, botId: this.botId, speakerUuid: participantUuid,
          utterance: { eventId: `lab-${randomBytes(6).toString('hex')}`, actor, text, at: Date.now() } };
        if (sttMode === 'flux-english') await this.router.acceptCompletedTurn(request);
        else await this.router.acceptFinal(request);
      },
      onSpeechActivity: (sessionId, participantUuid) => {
        this.log('stt_activity', { participant: participantUuid });
        this.router.noteSpeechActivity(sessionId, participantUuid);
      },
      onEagerTranscript: (sessionId, participantUuid, text) => {
        const actor = actors.get(participantUuid);
        this.log('stt_eager', { participant: participantUuid, text });
        if (!actor) return;
        this.router.acceptEagerTurn({ sessionId, botId: this.botId, speakerUuid: participantUuid,
          utterance: { eventId: `lab-${randomBytes(6).toString('hex')}`, actor, text, at: Date.now() } });
      },
      onVoice: (sessionId, participantUuid) => this.engine.noteVoice(sessionId, participantUuid),
      onTurnResumed: (sessionId, participantUuid) => {
        this.log('stt_resumed', { participant: participantUuid });
        this.router.resumeTurn(sessionId, participantUuid);
      },
      onError: code => this.log('error', { detail: code }),
    });
    this.engine = new NogitaEngine(this.options.dependencies, { ...this.options.engineOptions,
      onQuestion: (_sessionId, event) => this.log('question', { participant: `lab_${event.speaker.toLowerCase()}`, text: event.request,
        detail: `#${event.id} ${event.status}${event.topic ? ` [${event.topic}]` : ''}${event.detail ? `: ${event.detail}` : ''}` }) });
    this.router = new AttendeeCommandRouter(
      async (sessionId, utterance, context) => {
        this.log('utterance', { participant: context.speakerKey, text: utterance.text,
          ...(context.speculation ? { detail: 'early start adopted' } : {}) });
        this.pendingEngine++;
        try {
          const result = await this.engine.onUtterance(sessionId, utterance, { speakerKey: context.speakerKey,
            ...(context.speculation ? { speculation: context.speculation as Speculation } : {}) });
          this.log('engine_done', { detail: String(result) });
        } catch (error) {
          this.log('engine_error', { detail: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally { this.pendingEngine--; }
      },
      async (_sessionId, message) => this.meeting.sendStatus(message),
      { quietMs: this.options.routerQuietMs, onError: error => this.log('error',
        { detail: `router: ${error instanceof Error ? error.message : String(error)}` }),
      onSpeechActivity: (sessionId, speakerUuid) => this.engine.cancelProgressForSpeechActivity(sessionId, speakerUuid),
      chatAck: false,
      ...(this.options.eagerThreshold !== undefined ? { speculate: (sessionId: string, utterance: Utterance) => {
        const handle = this.engine.speculate(sessionId, utterance);
        if (handle) this.log('question', { text: utterance.text, detail: 'early start' });
        return handle;
      } } : {}) },
    );
    this.meeting = new LabMeeting(this.sessionId, this);
    await this.engine.startSession(this.sessionId, this.meeting);
    this.router.beginSession(this.sessionId);

    const url = new URL(this.hub.register(this.sessionId));
    this.hub.bindBot(this.sessionId, this.botId);
    this.server = createServer((_request, response) => { response.writeHead(404).end(); });
    this.server.on('upgrade', (request, socket, head) => {
      if (!this.hub.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.client = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { this.client!.once('open', resolve); this.client!.once('error', reject); });
    this.client.on('message', data => this.onBotOutput(data.toString()));

    for (const participant of participants) {
      const uuid = `lab_${participant.id}`;
      actors.set(uuid, participant.actor);
      this.hub.bindParticipant(this.sessionId, uuid, { displayName: participant.name });
      this.mics.set(participant.id, { participant, uuid, openUntil: 0, on: false });
    }
    this.t0 = performance.now();
    const frameMs = this.frameSamples * 1000 / SAMPLE_RATE;
    this.pump = setInterval(() => {
      // Send every frame whose audio has been "recorded" by now; catches up after timer jitter.
      const due = Math.floor((performance.now() - this.t0) / frameMs);
      while (this.sentFrames < due && !this.stopped) this.sendFrame();
    }, 5);
  }

  /** Speaks `samples` on a participant's mic from the next frame: when the first word starts, and a promise
   *  of the mic time of the last word. */
  say(participantId: string, samples: Float32Array): { start: number; ended: Promise<number> } {
    const mic = this.mics.get(participantId);
    if (!mic) throw new Error(`unknown participant ${participantId}`);
    if (mic.speech) throw new Error(`${participantId} is already speaking`);
    // A push-to-talk mic unmutes a moment before the words, like a person unmuting.
    const lead = mic.participant.mic === 'push' && !mic.on ? msToSamples(300) : 0;
    const at = this.micPosition + this.frameSamples + lead;
    mic.openUntil = Math.max(mic.openUntil, at + samples.length + msToSamples(2500));
    const start = this.micTime(at);
    const ended = new Promise<number>(resolve => { mic.speech = { samples, at, resolve }; });
    return { start, ended };
  }

  /** True while Nogita is producing or playing anything for the current turn. */
  get busy(): boolean {
    return this.pendingEngine > 0 || this.meeting.speaking > 0 || this.audioPlaying;
  }
  get audioActive(): boolean { return this.audioPlaying; }
  get lastNogitaAudioAt(): number { return this.lastAudioAt; }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pump) clearInterval(this.pump);
    this.client?.close();
    await this.engine.endSession(this.sessionId).catch(() => undefined);
    this.router.endSession(this.sessionId);
    this.hub.close();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  private sendFrame(): void {
    const position = this.sentFrames * this.frameSamples;
    const frameTime = this.micTime(position);
    for (const mic of this.mics.values()) {
      const open = mic.participant.mic === 'open' || position < mic.openUntil;
      if (open !== mic.on) {
        mic.on = open;
        this.log(open ? 'mic_on' : 'mic_off', { participant: mic.participant.id }, frameTime);
      }
      if (!open) continue;
      const frame = mic.participant.noise.next(this.frameSamples);
      const speech = mic.speech;
      if (speech) {
        const offset = position - speech.at;
        if (offset + this.frameSamples > 0 && offset < speech.samples.length) {
          if (offset <= 0 && offset + this.frameSamples > 0) this.log('speech_start', { participant: mic.participant.id }, this.micTime(speech.at));
          for (let i = 0; i < this.frameSamples; i++) frame[i]! += speech.samples[offset + i] ?? 0;
        }
        if (offset + this.frameSamples >= speech.samples.length) {
          const end = this.micTime(speech.at + speech.samples.length);
          this.log('speech_end', { participant: mic.participant.id }, end);
          mic.speech = undefined;
          speech.resolve(end);
        }
      }
      this.room.add(position, frame);
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ bot_id: this.botId, trigger: 'realtime_audio.per_participant', data: {
          participant_uuid: mic.uuid, chunk: floatToPcm(frame).toString('base64'), sample_rate: SAMPLE_RATE,
        } }));
      }
    }
    this.sentFrames++;
    if (this.audioPlaying && performance.now() - this.lastAudioAt > AUDIO_GAP_MS) {
      this.audioPlaying = false;
      this.log('audio_stop', {}, this.lastAudioAt);
    }
  }

  private onBotOutput(raw: string): void {
    let message: { trigger?: string; data?: { chunk?: string } };
    try { message = JSON.parse(raw) as typeof message; } catch { return; }
    if (message.trigger !== 'realtime_audio.bot_output' || typeof message.data?.chunk !== 'string') return;
    const samples = pcmToFloat(Buffer.from(message.data.chunk, 'base64'));
    const now = performance.now();
    // The hub paces output at playback speed, so arrival time is when the room hears it.
    if (!this.audioPlaying) { this.audioPlaying = true; this.log('audio_start', {}, now); }
    const at = Math.max(0, Math.round((now - this.t0) * SAMPLE_RATE / 1000));
    this.nogita.add(at, samples);
    this.lastAudioAt = now + samples.length * 1000 / SAMPLE_RATE;
  }
}
