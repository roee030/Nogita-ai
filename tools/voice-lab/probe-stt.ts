// Sends one synthesized line, padded with noise, to Deepgram STT and prints every non-Update event.
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { loadDotEnv } from '../../src/app/config.ts';
import { SAMPLE_RATE, concat, floatToPcm, msToSamples, rms } from './audio.ts';
import { createNoise } from './noise.ts';
import { deepgramSynthesizer } from './tts.ts';
loadDotEnv();
const [voice = 'aura-2-orion-en', text = 'Nogita, go ahead.', mode = 'flux'] = process.argv.slice(2);
const speech = await deepgramSynthesizer(process.env.DEEPGRAM_API_KEY!, resolve('.voice-lab/cache'))(voice, text);
console.log('speech ms', Math.round(speech.length / 16), 'rms', rms(speech).toFixed(3));
const noise = createNoise({ kind: 'pink', snrDb: 30 }, 5);
const audio = concat([noise.next(msToSamples(3000)), speech.map((v, i) => v), noise.next(msToSamples(6000))]);
for (let i = 0; i < speech.length; i++) audio[msToSamples(3000) + i]! += 0; // speech already placed
const mixed = concat([noise.next(msToSamples(3000)), speech, noise.next(msToSamples(6000))]);
const url = mode === 'flux'
  ? 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.8&eot_timeout_ms=7000&keyterm=Nogita'
  : 'wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&encoding=linear16&sample_rate=16000&interim_results=true&endpointing=500&utterance_end_ms=1000&keyterm=Nogita';
const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
const t0 = performance.now();
ws.on('message', d => { const s = d.toString(); if (!s.includes('"Update"')) console.log(Math.round(performance.now() - t0), s.slice(0, 200)); });
await new Promise(r => ws.once('open', r));
const pcm = floatToPcm(mixed);
for (let i = 0; i < pcm.length; i += 640) { ws.send(pcm.subarray(i, i + 640)); await new Promise(r => setTimeout(r, 20)); }
await new Promise(r => setTimeout(r, 3000));
ws.close();
void SAMPLE_RATE;
