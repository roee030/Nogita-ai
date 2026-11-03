/**
 * P7-1 (throwaway): a voice-lab rig whose "Nogita" is one Gemini Live session. It looks enough like VoiceRig for
 * `playScenario` (say, events, busy, audioActive): every participant's microphone (speech plus their own noise) is
 * mixed and streamed to Gemini at real time, as a person in the room would hear it, and Gemini's audio is "played"
 * on a real-time clock that stops the moment the server says it was interrupted. Nothing reaches Nogita's engine.
 */
import { FRAME_SAMPLES, SAMPLE_RATE, floatToPcm, pcmToFloat } from '../voice-lab/audio.ts';
import type { NoiseSource } from '../voice-lab/noise.ts';
import type { LabEvent, LabEventType } from '../voice-lab/rig.ts';
import { GeminiLive } from './live.ts';

export interface SpikeMic { id: string; noise: NoiseSource }

/** Gemini's 24 kHz output to 16 kHz for the session recording (linear interpolation; listening quality only). */
export function downsample24to16(pcm24: Buffer): Float32Array {
  const input = pcmToFloat(pcm24);
  const out = new Float32Array(Math.floor(input.length * 2 / 3));
  for (let i = 0; i < out.length; i++) {
    const at = i * 1.5, low = Math.floor(at), frac = at - low;
    out[i] = (input[low] ?? 0) * (1 - frac) + (input[low + 1] ?? input[low] ?? 0) * frac;
  }
  return out;
}

export class GeminiRig {
  readonly events: LabEvent[] = [];
  /** Spoken output, as heard text (Gemini's own transcription of what it said). */
  readonly said: Array<{ t: number; text: string }> = [];
  readonly heard: Array<{ t: number; text: string }> = [];
  /** The session as a listener heard it: the room mix plus her voice, 16 kHz. */
  readonly recording: Float32Array[] = [];
  readonly live: GeminiLive;
  private readonly mics = new Map<string, { noise: NoiseSource; speeches: Array<{ samples: Float32Array; at: number; resolve: (t: number) => void }> }>();
  private timer?: ReturnType<typeof setInterval>;
  private t0 = 0;
  private sent = 0;
  private playing = false;
  private playbackEnd = 0;
  private generating = false;
  private outQueue: Float32Array[] = [];

  constructor(apiKey: string, model: string, system: string, voice?: string) {
    this.live = new GeminiLive(apiKey, model, system, voice);
  }

  get busy(): boolean { return this.playing || this.generating; }
  get audioActive(): boolean { return this.playing; }

  log(type: LabEventType, fields: Omit<LabEvent, 't' | 'type'> = {}, t = performance.now()): void {
    this.events.push({ t, type, ...fields });
  }

  async start(mics: SpikeMic[]): Promise<void> {
    for (const mic of mics) this.mics.set(mic.id, { noise: mic.noise, speeches: [] });
    await this.live.open({
      onAudio: pcm => {
        const now = performance.now();
        if (!this.playing) { this.playing = true; this.playbackEnd = now; this.log('audio_start', {}, now); }
        this.generating = true;
        this.playbackEnd = Math.max(this.playbackEnd, now) + pcm.length / 2 / 24;
        this.outQueue.push(downsample24to16(pcm));
      },
      onInterrupted: () => {
        const now = performance.now();
        this.log('interrupt', { cause: 'voice' }, now);
        this.generating = false;
        this.outQueue = [];
        if (this.playing) { this.playing = false; this.playbackEnd = now; this.log('audio_stop', {}, now); }
      },
      onTurnComplete: () => { this.generating = false; this.log('engine_done'); },
      onInputText: text => { this.heard.push({ t: performance.now(), text }); this.log('utterance', { text }); },
      onOutputText: text => this.said.push({ t: performance.now(), text }),
      onError: message => this.log('error', { detail: message }),
    });
    this.t0 = performance.now();
    this.timer = setInterval(() => this.pump(), 10);
  }

  /** Same contract as VoiceRig.say: the line starts now on that microphone. */
  say(micId: string, samples: Float32Array): { start: number; ended: Promise<number> } {
    const mic = this.mics.get(micId);
    if (!mic) throw new Error(`no mic ${micId}`);
    const at = this.sent * FRAME_SAMPLES;
    const start = this.micTime(at);
    let resolve!: (t: number) => void;
    const ended = new Promise<number>(r => { resolve = r; });
    mic.speeches.push({ samples, at, resolve });
    this.log('speech_start', { participant: micId }, start);
    return { start, ended };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.live.close();
  }

  private micTime(sample: number): number { return this.t0 + sample * 1000 / SAMPLE_RATE; }

  /** Sends every 20 ms frame that is due, and moves the playback clock. */
  private pump(): void {
    const now = performance.now();
    while (this.micTime((this.sent + 1) * FRAME_SAMPLES) <= now) {
      const position = this.sent * FRAME_SAMPLES;
      const mix = new Float32Array(FRAME_SAMPLES);
      for (const [id, mic] of this.mics) {
        const frame = mic.noise.next(FRAME_SAMPLES);
        for (const speech of [...mic.speeches]) {
          const offset = position - speech.at;
          for (let i = 0; i < FRAME_SAMPLES; i++) frame[i]! += speech.samples[offset + i] ?? 0;
          if (offset + FRAME_SAMPLES >= speech.samples.length) {
            const end = this.micTime(speech.at + speech.samples.length);
            this.log('speech_end', { participant: id }, end);
            mic.speeches.splice(mic.speeches.indexOf(speech), 1);
            speech.resolve(end);
          }
        }
        for (let i = 0; i < FRAME_SAMPLES; i++) mix[i]! += frame[i]!;
      }
      this.live.sendAudio(floatToPcm(mix));
      // The listener's recording: the room, plus whatever of her voice is playing in this frame.
      const out = new Float32Array(mix);
      if (this.playing) {
        let need = FRAME_SAMPLES, k = 0;
        while (need > 0 && this.outQueue.length) {
          const chunk = this.outQueue[0]!;
          const take = Math.min(need, chunk.length);
          for (let i = 0; i < take; i++) out[k + i]! += chunk[i]!;
          k += take; need -= take;
          if (take === chunk.length) this.outQueue.shift(); else this.outQueue[0] = chunk.subarray(take);
        }
      }
      this.recording.push(out);
      this.sent++;
    }
    // A gap between streamed chunks is not the end of her speech (the voice lab's rule: 250 ms of nothing is).
    if (this.playing && now >= this.playbackEnd + (this.generating ? 250 : 0)) {
      this.playing = false;
      this.log('audio_stop', {}, this.playbackEnd);
    }
  }
}
