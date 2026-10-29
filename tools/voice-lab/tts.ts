/**
 * Spoken lines for the lab's participants, synthesized once with Deepgram Aura-2 (REST) and cached on disk.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRms, pcmToFloat, scale, trimSilence } from './audio.ts';
import { SPEECH_RMS } from './noise.ts';

export type Synthesize = (voice: string, text: string) => Promise<Float32Array>;

export function deepgramSynthesizer(apiKey: string, cacheDir: string, http: typeof fetch = fetch): Synthesize {
  const once = synthesizeOnce(apiKey, cacheDir, http);
  return async (voice, text) => {
    // Aura occasionally returns a near-silent, unintelligible clip ("Nogita, go ahead." peaked at -21 dBFS and
    // no recognizer heard a word). Such a clip would be blamed on Nogita, so retry with a variant spelling.
    for (const variant of [text, `${text.replace(/[.!?]+$/, '')}!`, `${text} `]) {
      const pcm = await once(voice, variant);
      if (peak(pcm) >= 0.18) return normalizeSpeech(pcmToFloat(pcm));
    }
    throw new Error(`speech synthesis produced unusable audio for "${text}"`);
  };
}

function peak(pcm: Buffer): number {
  let max = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  return max / 32768;
}

function synthesizeOnce(apiKey: string, cacheDir: string, http: typeof fetch): (voice: string, text: string) => Promise<Buffer> {
  return async (voice, text) => {
    if (!/^aura-2-[a-z]+-en$/.test(voice)) throw new Error(`unsupported voice ${voice}`);
    const key = createHash('sha256').update(`${voice}\0${text}`).digest('hex').slice(0, 32);
    const file = join(cacheDir, `${key}.pcm`);
    let pcm: Buffer;
    try { pcm = await readFile(file); }
    catch {
      const url = new URL('https://api.deepgram.com/v1/speak');
      url.searchParams.set('model', voice);
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', '16000');
      url.searchParams.set('container', 'none');
      let response: Response;
      for (let attempt = 1; ; attempt++) {
        response = await http(url, { method: 'POST',
          headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }), signal: AbortSignal.timeout(30_000) });
        // Concurrency limits answer 429; back off and retry a few times.
        if (response.status !== 429 || attempt >= 6) break;
        await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
      }
      if (!response.ok) throw new Error(`Deepgram TTS failed: HTTP ${response.status}`);
      pcm = Buffer.from(await response.arrayBuffer());
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, pcm);
    }
    return pcm;
  };
}

/** Trimmed to the words and set to the lab's reference level, so SNR numbers mean the same for every line. */
export function normalizeSpeech(samples: Float32Array): Float32Array {
  const trimmed = trimSilence(samples);
  const level = activeRms(trimmed);
  return level > 0 ? scale(trimmed, SPEECH_RMS / level) : trimmed;
}
