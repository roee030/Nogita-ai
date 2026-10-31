import Cartesia from '@cartesia/cartesia-js';
import { WebSocket } from 'ws';
import type { TtsBenchmarkProvider } from './tts-benchmark.ts';

const timeout = (ms: number) => new Promise<never>((_, reject) => {
  const handle = setTimeout(() => reject(new Error('TTS benchmark timed out')), ms);
  handle.unref?.();
});

export function deepgramTtsBenchmarkProvider(apiKey: string, model = 'aura-2-thalia-en',
  createSocket?: () => WebSocket): TtsBenchmarkProvider {
  return { name: 'deepgram', model, voice: model.replace(/^aura-2-/, '').replace(/-en$/, ''), sampleRate: 16_000,
    open: async () => {
      const started = performance.now();
      const url = `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=16000&mip_opt_out=true`;
      const socket = createSocket?.() ?? new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` },
        handshakeTimeout: 10_000, maxPayload: 5 * 1024 * 1024 });
      await Promise.race([new Promise<void>((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Deepgram TTS socket closed during handshake')));
      }), timeout(12_000)]);
      const connectMs = Math.round(performance.now() - started);
      return { connectMs,
        synthesize: async (text: string) => {
          const requestAt = performance.now();
          let firstAudioAt: number | undefined;
          const chunks: Buffer[] = [];
          const result = new Promise<{ ttfaMs: number; totalMs: number; audio: Buffer }>((resolve, reject) => {
            const cleanup = () => { socket.off('message', onMessage); socket.off('error', onError); socket.off('close', onClose); };
            const onError = () => { cleanup(); reject(new Error('Deepgram TTS socket error')); };
            const onClose = () => { cleanup(); reject(new Error('Deepgram TTS socket closed before completion')); };
            const onMessage = (data: WebSocket.RawData, binary: boolean) => {
              if (binary) {
                firstAudioAt ??= performance.now();
                chunks.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data as ArrayBuffer));
                return;
              }
              let message: { type?: string };
              try { message = JSON.parse(data.toString()) as { type?: string }; }
              catch { return; }
              if (message.type === 'Flushed') {
                cleanup();
                if (firstAudioAt === undefined || !chunks.length) { reject(new Error('Deepgram TTS returned no audio')); return; }
                resolve({ ttfaMs: Math.round(firstAudioAt - requestAt), totalMs: Math.round(performance.now() - requestAt),
                  audio: Buffer.concat(chunks) });
              } else if (message.type === 'Error') { cleanup(); reject(new Error('Deepgram TTS reported an error')); }
            };
            socket.on('message', onMessage);
            socket.once('error', onError);
            socket.once('close', onClose);
            socket.send(JSON.stringify({ type: 'Speak', text }));
            socket.send(JSON.stringify({ type: 'Flush' }));
          });
          return Promise.race([result, timeout(20_000)]);
        },
        close: async () => {
          if (socket.readyState === WebSocket.CLOSED) return;
          await Promise.race([new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); }),
            new Promise<void>(resolve => setTimeout(resolve, 500))]);
        } };
    } };
}

interface CartesiaContextLike {
  push(input: { transcript: string }): Promise<void>;
  no_more_inputs(): Promise<void>;
  receive(): AsyncIterable<{ type: string; audio?: Uint8Array; data?: string; title?: string; message?: string }>;
}
interface CartesiaSocketLike {
  context(options: Record<string, unknown>): CartesiaContextLike;
  close(): void;
}
interface CartesiaClientLike { tts: { websocket(): Promise<CartesiaSocketLike> } }

export function cartesiaTtsBenchmarkProvider(apiKey: string,
  voice = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', model = 'sonic-3.6',
  createClient: () => CartesiaClientLike = () => new Cartesia({ apiKey }) as unknown as CartesiaClientLike): TtsBenchmarkProvider {
  return { name: 'cartesia', model, voice, sampleRate: 16_000,
    open: async () => {
      const started = performance.now();
      const socket = await Promise.race([createClient().tts.websocket(), timeout(12_000)]);
      const connectMs = Math.round(performance.now() - started);
      return { connectMs,
        synthesize: async (text: string) => {
          const requestAt = performance.now();
          let firstAudioAt: number | undefined;
          const chunks: Buffer[] = [];
          const context = socket.context({ model_id: model, voice,
            output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16_000 }, language: 'en',
            max_buffer_delay_ms: 0, timeout: 20_000 });
          await context.push({ transcript: text });
          await context.no_more_inputs();
          for await (const event of context.receive()) {
            if (event.type === 'chunk') {
              const audio = event.audio ? Buffer.from(event.audio) : event.data ? Buffer.from(event.data, 'base64') : undefined;
              if (audio?.length) { firstAudioAt ??= performance.now(); chunks.push(audio); }
            } else if (event.type === 'error') {
              throw new Error(`Cartesia TTS error${event.title ? `: ${event.title}` : ''}`);
            } else if (event.type === 'done') break;
          }
          if (firstAudioAt === undefined || !chunks.length) throw new Error('Cartesia TTS returned no audio');
          return { ttfaMs: Math.round(firstAudioAt - requestAt), totalMs: Math.round(performance.now() - requestAt),
            audio: Buffer.concat(chunks) };
        },
        close: async () => { socket.close(); } };
    } };
}
