/**
 * Endless, deterministic background noise for a participant's microphone. Every source is normalized to
 * RMS 1 and then scaled so it sits `snrDb` below the lab's reference speech level.
 */
import { FRAME_SAMPLES, SAMPLE_RATE, noiseGainForSnr, rms } from './audio.ts';

export type NoiseKind = 'quiet' | 'white' | 'pink' | 'brown' | 'hum' | 'keyboard' | 'office' | 'cafe' | 'street';
export type PerturbationKind = 'cough' | 'typing' | 'laughter';
export interface NoiseSpec { kind: NoiseKind; snrDb: number }
export interface NoiseSource { next(samples: number): Float32Array }

/** Active RMS every spoken line is normalized to before mixing (about -20 dBFS). */
export const SPEECH_RMS = 0.1;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic non-speech clips injected through a real participant microphone while Nogita is speaking. */
export function createPerturbation(kind: PerturbationKind, seed = 1): Float32Array {
  const random = rng(seed);
  const durationMs = kind === 'cough' ? 700 : kind === 'typing' ? 900 : 1_100;
  const out = new Float32Array(Math.round(SAMPLE_RATE * durationMs / 1_000));
  if (kind === 'typing') {
    for (let hit = 40; hit < durationMs - 30; hit += 65 + Math.floor(random() * 95)) {
      const start = Math.round(hit * SAMPLE_RATE / 1_000);
      const decay = 5 + random() * 7;
      for (let i = 0; i < Math.round(SAMPLE_RATE * 0.035) && start + i < out.length; i++) {
        const envelope = Math.exp(-i / (SAMPLE_RATE * decay / 1_000));
        out[start + i] += (random() * 2 - 1) * envelope;
      }
    }
  } else if (kind === 'cough') {
    let filtered = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      const burst = Math.exp(-(((t - 0.20) / 0.075) ** 2)) +
        0.75 * Math.exp(-(((t - 0.43) / 0.105) ** 2));
      filtered = filtered * 0.72 + (random() * 2 - 1) * 0.28;
      out[i] = burst * (0.72 * filtered + 0.28 * Math.sin(2 * Math.PI * 115 * t));
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      const pulse = Math.max(0, Math.sin(2 * Math.PI * 4.2 * t - 0.7));
      const fade = Math.min(1, t / 0.08, (durationMs / 1_000 - t) / 0.12);
      const voiced = Math.sin(2 * Math.PI * 185 * t) + 0.35 * Math.sin(2 * Math.PI * 370 * t);
      out[i] = Math.max(0, fade) * (0.75 * pulse * voiced + 0.15 * (random() * 2 - 1));
    }
  }
  const level = rms(out) || 1;
  const target = kind === 'typing' ? 0.07 : 0.09;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-0.95, Math.min(0.95, out[i]! * target / level));
  return out;
}

type Generator = () => number;

function white(random: () => number): Generator { return () => random() * 2 - 1; }

/** Paul Kellet's pink filter. */
function pink(random: () => number): Generator {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out;
  };
}

function brown(random: () => number): Generator {
  let last = 0;
  return () => { last = (last + 0.02 * (random() * 2 - 1)) / 1.02; return last; };
}

function hum(): Generator {
  let n = 0;
  return () => {
    const t = n++ / SAMPLE_RATE;
    return Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.25 * Math.sin(2 * Math.PI * 150 * t);
  };
}

/** Short decaying bursts at random intervals: keys, cups, chairs. */
function clicks(random: () => number, minGapMs: number, maxGapMs: number, decayMs: number, tone?: number): Generator {
  let wait = 0;
  let energy = 0;
  let phase = 0;
  const decay = Math.exp(-1 / (SAMPLE_RATE * decayMs / 1000));
  return () => {
    if (wait-- <= 0) {
      wait = Math.round((minGapMs + random() * (maxGapMs - minGapMs)) * SAMPLE_RATE / 1000);
      energy = 0.4 + random() * 0.6;
    }
    energy *= decay;
    phase += tone ? 2 * Math.PI * tone / SAMPLE_RATE : 0;
    return energy * (tone ? Math.sin(phase) : random() * 2 - 1);
  };
}

/** Several talkers looping through background lines with random gaps: intelligible at 2-3 voices, babble beyond. */
function babble(random: () => number, lines: Float32Array[], voices: number): Generator {
  if (!lines.length) return pink(random);
  const talkers = Array.from({ length: voices }, () => ({
    line: Math.floor(random() * lines.length), at: -Math.floor(random() * SAMPLE_RATE * 3), gain: 0.6 + random() * 0.4,
  }));
  return () => {
    let sum = 0;
    for (const talker of talkers) {
      if (talker.at >= 0) {
        const line = lines[talker.line]!;
        sum += (line[talker.at] ?? 0) * talker.gain;
        if (++talker.at >= line.length) {
          talker.line = Math.floor(random() * lines.length);
          talker.at = -Math.floor((0.2 + random() * 1.5) * SAMPLE_RATE);
        }
      } else talker.at++;
    }
    return sum;
  };
}

function mix(parts: Array<[Generator, number]>): Generator {
  return () => parts.reduce((sum, [generate, gain]) => sum + generate() * gain, 0);
}

/** Normalizes a generator to RMS 1, measured over its first ten seconds. */
function normalized(make: () => Generator): Generator {
  const probe = make();
  const sample = new Float32Array(SAMPLE_RATE * 10);
  for (let i = 0; i < sample.length; i++) sample[i] = probe();
  const level = rms(sample) || 1;
  const generate = make();
  return () => generate() / level;
}

/**
 * A noise bed for one microphone. `babbleLines` are background speech clips (other voices, unrelated talk)
 * used by the office and cafe profiles.
 */
export function createNoise(spec: NoiseSpec, seed: number, babbleLines: Float32Array[] = []): NoiseSource {
  const quietFloor = SPEECH_RMS / 10 ** (70 / 20);
  const make = (): Generator => {
    const random = rng(seed);
    switch (spec.kind) {
      case 'quiet': return white(random);
      case 'white': return white(random);
      case 'pink': return pink(random);
      case 'brown': return brown(random);
      case 'hum': return mix([[hum(), 1], [pink(random), 0.3]]);
      case 'keyboard': return mix([[clicks(random, 60, 260, 6), 1], [pink(random), 0.08]]);
      case 'office': return mix([[babble(random, babbleLines, 3), 1], [pink(random), 0.05],
        [clicks(random, 80, 900, 5), 0.2]]);
      case 'cafe': return mix([[babble(random, babbleLines, 6), 1], [pink(random), 0.12],
        [clicks(random, 400, 2500, 40, 2400), 0.25]]);
      case 'street': return mix([[brown(random), 1], [pink(random), 0.3], [clicks(random, 1500, 6000, 400, 180), 0.5]]);
    }
  };
  const generate = normalized(make);
  const gain = spec.kind === 'quiet' ? quietFloor : noiseGainForSnr(SPEECH_RMS, 1, spec.snrDb);
  return {
    next(samples = FRAME_SAMPLES): Float32Array {
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) out[i] = generate() * gain;
      return out;
    },
  };
}
