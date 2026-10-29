/**
 * Deepgram Aura-2 WebSocket: time to first audio for a sentence on a fresh connection and on a warm one.
 * Usage: node --experimental-transform-types tools/voice-lab/probe-tts.ts
 */
import { WebSocket } from 'ws';
import { loadDotEnv } from '../../src/app/config.ts';

loadDotEnv();
const url = 'wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000';
const sentence = 'The main check is in the Jira adapter, inside createTask.';

function firstAudio(ws: WebSocket, text: string): Promise<number> {
  return new Promise(resolve => {
    const started = performance.now();
    const onMessage = (_data: unknown, binary: boolean) => {
      if (!binary) return;
      ws.off('message', onMessage);
      resolve(Math.round(performance.now() - started));
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'Speak', text }));
    ws.send(JSON.stringify({ type: 'Flush' }));
  });
}

const cold: number[] = [];
const warm: number[] = [];
for (let i = 0; i < 4; i++) {
  const started = performance.now();
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
  await new Promise(r => ws.once('open', r));
  const connect = performance.now() - started;
  cold.push(Math.round(connect + await firstAudio(ws, sentence)));
  await new Promise(r => setTimeout(r, 1500));
  warm.push(await firstAudio(ws, sentence));
  ws.close();
}
console.log(`fresh connection + first audio: ${cold.join(' ')} ms`);
console.log(`warm connection first audio:    ${warm.join(' ')} ms`);
