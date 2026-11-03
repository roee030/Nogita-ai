/**
 * P7-1 probe: one Gemini Live session, one spoken question (Deepgram TTS), and every server message type printed.
 *   node --experimental-transform-types tools/gemini-spike/probe.ts
 */
import WebSocket from 'ws';
import { loadDotEnv } from '../../src/app/config.ts';

loadDotEnv();
const key = process.env.GEMINI_API_KEY!;
const model = process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live';
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

async function speech(text: string): Promise<Buffer> {
  const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=none',
    { method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!response.ok) throw new Error(`deepgram ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const pcm = await speech('Hey Nogita, how many pull requests did we merge today?');
const socket = new WebSocket(url);
const t0 = Date.now();
const seen = new Map<string, number>();
let audioBytes = 0;
socket.on('open', () => {
  socket.send(JSON.stringify({ setup: { model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: 'You are Nogita, a meeting assistant. Answer in one short sentence.' }] },
    inputAudioTranscription: {}, outputAudioTranscription: {} } }));
});
socket.on('message', data => {
  const message = JSON.parse(data.toString()) as Record<string, any>;
  for (const top of Object.keys(message)) {
    const sub = top === 'serverContent' ? Object.keys(message.serverContent).join('+') : '';
    const label = sub ? `${top}.${sub}` : top;
    if (!seen.has(label)) { seen.set(label, Date.now() - t0); console.log(`${Date.now() - t0}ms ${label}`, JSON.stringify(message).replace(/"data":"[^"]{40,}"/g, '"data":"…"').slice(0, 300)); }
  }
  for (const part of message.serverContent?.modelTurn?.parts ?? []) if (part.inlineData) audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
  if (message.setupComplete) {
    // 20 ms frames at real time, then 1.5 s of silence so the model's VAD sees the end of speech.
    const frames: Buffer[] = [];
    for (let i = 0; i < pcm.length; i += 640) frames.push(pcm.subarray(i, i + 640));
    for (let i = 0; i < 75; i++) frames.push(Buffer.alloc(640));
    let n = 0;
    const timer = setInterval(() => {
      const frame = frames[n++];
      if (!frame) { clearInterval(timer); return; }
      socket.send(JSON.stringify({ realtimeInput: { audio: { data: frame.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    }, 20);
  }
  if (message.serverContent?.turnComplete) { console.log(`audio out ${audioBytes} bytes (~${(audioBytes / 48000).toFixed(1)} s at 24 kHz)`); socket.close(); }
});
socket.on('close', (code, reason) => { console.log('closed', code, reason.toString().slice(0, 300)); process.exit(0); });
socket.on('error', error => { console.log('error', error.message); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 40_000);
