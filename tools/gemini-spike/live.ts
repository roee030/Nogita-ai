/**
 * P7-1 (throwaway): the smallest Gemini Live client the viability spike needs. One WebSocket, no reconnect, no
 * resumption, no tools. Audio in is 16 kHz PCM16 (what Attendee sends); audio out is 24 kHz PCM16.
 */
import WebSocket from 'ws';

export interface LiveUsage { promptTokens: number; responseTokens: number; audioPromptTokens: number; audioResponseTokens: number;
  textPromptTokens: number; turns: number }

export interface LiveEvents {
  onAudio(pcm24k: Buffer): void;
  /** The server stopped its answer because someone started talking (barge-in). */
  onInterrupted(): void;
  onTurnComplete(): void;
  onInputText?(text: string): void;
  onOutputText?(text: string): void;
  onError?(message: string): void;
}

export class GeminiLive {
  readonly usage: LiveUsage = { promptTokens: 0, responseTokens: 0, audioPromptTokens: 0, audioResponseTokens: 0, textPromptTokens: 0, turns: 0 };
  private socket?: WebSocket;

  constructor(private readonly apiKey: string, private readonly model: string, private readonly system: string,
    private readonly voice?: string) {}

  async open(events: LiveEvents): Promise<void> {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    const socket = this.socket = new WebSocket(url, { handshakeTimeout: 15_000 });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.on('open', () => {
        socket.send(JSON.stringify({ setup: { model: `models/${this.model}`,
          generationConfig: { responseModalities: ['AUDIO'],
            ...(this.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } } } : {}) },
          systemInstruction: { parts: [{ text: this.system }] },
          inputAudioTranscription: {}, outputAudioTranscription: {} } }));
      });
      socket.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, any>;
        if (message.setupComplete) { resolve(); return; }
        const content = message.serverContent;
        if (content?.interrupted) events.onInterrupted();
        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) events.onAudio(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (content?.inputTranscription?.text) events.onInputText?.(content.inputTranscription.text);
        if (content?.outputTranscription?.text) events.onOutputText?.(content.outputTranscription.text);
        if (content?.turnComplete) events.onTurnComplete();
        const usage = message.usageMetadata;
        if (usage) {
          this.usage.turns++;
          this.usage.promptTokens += usage.promptTokenCount ?? 0;
          this.usage.responseTokens += usage.responseTokenCount ?? 0;
          for (const item of usage.promptTokensDetails ?? []) {
            if (item.modality === 'AUDIO') this.usage.audioPromptTokens += item.tokenCount ?? 0;
            if (item.modality === 'TEXT') this.usage.textPromptTokens += item.tokenCount ?? 0;
          }
          for (const item of usage.responseTokensDetails ?? []) if (item.modality === 'AUDIO') this.usage.audioResponseTokens += item.tokenCount ?? 0;
        }
      });
      socket.on('close', (code, reason) => { if (code !== 1000) events.onError?.(`closed ${code} ${reason.toString().slice(0, 200)}`); });
    });
  }

  sendAudio(pcm16k: Buffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  close(): void { this.socket?.close(1000); }
}

/** Gemini TTS for a participant's line (the Hebrew speakers; Aura has no Hebrew). 24 kHz PCM16 out. */
export async function geminiSpeech(apiKey: string, text: string, voice: string, model = 'gemini-3.8-flash-tts'): Promise<Buffer> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
  });
  if (!response.ok) throw new Error(`gemini tts ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const data = body.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
  if (!data) throw new Error('gemini tts returned no audio');
  return Buffer.from(data, 'base64');
}
