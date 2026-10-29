/**
 * 16 kHz mono 16-bit PCM helpers for the voice lab: the same format Attendee streams per participant
 * and Deepgram returns for Nogita's voice.
 */
export const SAMPLE_RATE = 16_000;
/** 20 ms of audio, the frame size the lab streams in real time. */
export const FRAME_SAMPLES = 320;

export function msToSamples(ms: number): number { return Math.round(ms * SAMPLE_RATE / 1000); }
export function samplesToMs(samples: number): number { return samples * 1000 / SAMPLE_RATE; }

/** Raw little-endian PCM bytes to samples in [-1, 1]. */
export function pcmToFloat(pcm: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export function floatToPcm(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return out;
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  const end = Math.min(to, samples.length);
  for (let i = from; i < end; i++) sum += samples[i]! * samples[i]!;
  return end > from ? Math.sqrt(sum / (end - from)) : 0;
}

/** RMS over the louder frames only, so leading/trailing silence in TTS audio does not skew the SNR. */
export function activeRms(samples: Float32Array): number {
  const levels: number[] = [];
  for (let i = 0; i + FRAME_SAMPLES <= samples.length; i += FRAME_SAMPLES) levels.push(rms(samples, i, i + FRAME_SAMPLES));
  if (!levels.length) return rms(samples);
  const peak = Math.max(...levels);
  const active = levels.filter(level => level > peak * 0.1);
  return Math.sqrt(active.reduce((sum, level) => sum + level * level, 0) / active.length);
}

/** Gain that puts noise of level `noiseRms` at `snrDb` below speech of level `speechRms`. */
export function noiseGainForSnr(speechRms: number, noiseRms: number, snrDb: number): number {
  if (noiseRms <= 0) return 0;
  return speechRms / (noiseRms * 10 ** (snrDb / 20));
}

export function scale(samples: Float32Array, gain: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * gain;
  return out;
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Leading/trailing silence trimmed to `keepMs`, so "end of speech" is the end of the words. */
export function trimSilence(samples: Float32Array, keepMs = 30): Float32Array {
  const threshold = Math.max(0.004, activeRms(samples) * 0.05);
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]!) < threshold) end--;
  const keep = msToSamples(keepMs);
  return samples.slice(Math.max(0, start - keep), Math.min(samples.length, end + keep));
}

/** A growable track addressed by absolute sample position, used to rebuild the conversation as heard. */
export class Track {
  private data = new Float32Array(SAMPLE_RATE * 60);
  length = 0;
  add(at: number, samples: Float32Array): void {
    if (at < 0) { samples = samples.subarray(-at); at = 0; }
    const end = at + samples.length;
    if (end > this.data.length) {
      const grown = new Float32Array(Math.max(end, this.data.length * 2));
      grown.set(this.data);
      this.data = grown;
    }
    for (let i = 0; i < samples.length; i++) this.data[at + i]! += samples[i]!;
    this.length = Math.max(this.length, end);
  }
  samples(): Float32Array { return this.data.subarray(0, this.length); }
}

/** WAV file bytes; two channels are interleaved left/right. */
export function wav(channels: Float32Array[]): Buffer {
  const frames = Math.max(...channels.map(channel => channel.length));
  const count = channels.length;
  const body = Buffer.alloc(frames * count * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      body.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), (i * count + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + body.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(count, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * count * 2, 28);
  header.writeUInt16LE(count * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}
