/**
 * How long after the last word Flux reports the end of a turn, for several settings, on the same spoken lines
 * with pink noise. Usage: node --experimental-transform-types tools/voice-lab/probe-endpoint.ts
 */
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { loadDotEnv } from '../../src/app/config.ts';
import { concat, floatToPcm, msToSamples } from './audio.ts';
import { createNoise } from './noise.ts';
import { deepgramSynthesizer } from './tts.ts';

loadDotEnv();
const key = process.env.DEEPGRAM_API_KEY!;
const synthesize = deepgramSynthesizer(key, resolve('.voice-lab/cache'));
const lines = ['Nogita, what changed in the last few commits?', 'Nogita, which file has the main meeting engine?',
  'Nogita, open a task to add rate limiting to the webhook endpoint.', 'Nogita, who is blocked right now?'];
const variants: Record<string, string> = {
  'eot 0.8 (today)': 'eot_threshold=0.8&eot_timeout_ms=3000',
  'eot 0.7 (default)': 'eot_threshold=0.7&eot_timeout_ms=3000',
  'eot 0.7 + eager 0.4': 'eot_threshold=0.7&eager_eot_threshold=0.4&eot_timeout_ms=3000',
};

async function measure(params: string, speech: Float32Array): Promise<{ eager?: number; end?: number; text?: string }> {
  const noise = createNoise({ kind: 'pink', snrDb: 25 }, 9);
  const lead = msToSamples(1500);
  const pcm = floatToPcm(concat([noise.next(lead), speech, noise.next(msToSamples(4000))]));
  const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&keyterm=Nogita&${params}`,
    { headers: { Authorization: `Token ${key}` } });
  await new Promise(r => ws.once('open', r));
  const t0 = performance.now();
  const speechEnd = t0 + (lead + speech.length) / 16;
  const result: { eager?: number; end?: number; text?: string } = {};
  ws.on('message', data => {
    const message = JSON.parse(data.toString()) as { type: string; event?: string; transcript?: string };
    if (message.type !== 'TurnInfo') return;
    if (message.event === 'EagerEndOfTurn' && result.eager === undefined) result.eager = Math.round(performance.now() - speechEnd);
    if (message.event === 'EndOfTurn' && result.end === undefined) { result.end = Math.round(performance.now() - speechEnd); result.text = message.transcript; }
  });
  for (let i = 0; i < pcm.length; i += 640) {
    ws.send(pcm.subarray(i, i + 640));
    const due = t0 + (i / 640 + 1) * 20;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  await new Promise(r => setTimeout(r, 500));
  ws.close();
  return result;
}

const clips = [];
for (const [i, line] of lines.entries()) clips.push(await synthesize(i % 2 ? 'aura-2-luna-en' : 'aura-2-orion-en', line));
for (const [name, params] of Object.entries(variants)) {
  const ends: number[] = [];
  const eagers: number[] = [];
  for (const clip of clips) {
    const r = await measure(params, clip);
    if (r.end !== undefined) ends.push(r.end);
    if (r.eager !== undefined) eagers.push(r.eager);
  }
  const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined;
  console.log(`${name.padEnd(22)} EndOfTurn median ${median(ends)} ms [${ends.join(' ')}]  EagerEndOfTurn median ${median(eagers) ?? '-'} ms [${eagers.join(' ')}]`);
}
