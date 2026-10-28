import type { AiUsage, SpeechStage, UsagePort } from '../core/contracts.ts';

interface SessionTiming {
  provider: string; startedAt: number; endedAt?: number; realtimeAudio?: boolean;
  deepgramSttAudioSeconds: number; deepgramTtsCharacters: number;
  ttsRequests: number; ttsFailures: number; createTasks: number; codeLookups: number;
  responseMs: number[];
  speechMs: Record<SpeechStage, number[]>;
}
type LatencySummary = { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
const SPEECH_STAGES: readonly SpeechStage[] = ['chat_mirror', 'tts_synthesis', 'audio_submission', 'speech_submission'];
export interface SessionUsageReport {
  sessionId: string;
  provider: string;
  active: boolean;
  durationSeconds: number;
  transcriptionMode?: 'closed_captions' | 'realtime_nova3_per_speaker';
  speechPipeline?: 'closed_captions_mp3' | 'deepgram_aura_stream';
  meetingEstimatedUsd: number;
  deepgramEstimatedUsd: number;
  deepgramUsage?: { sttAudioSeconds: number; ttsCharacters: number };
  tts: { requests: number; failures: number };
  externalActions: { create_task: number; code_lookup: number };
  ai?: AiUsage;
  totalEstimatedUsd: number;
  processingLatency: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
  speechLatency: Record<SpeechStage, LatencySummary>;
}

export class SessionUsageRegistry implements UsagePort {
  private readonly sessions = new Map<string, SessionTiming>();
  constructor(private readonly attendeeUsdPerHour = 0.50, private readonly now = Date.now,
    private readonly deepgramSttUsdPerMinute = 0.0058, private readonly deepgramTtsUsdPerThousandCharacters = 0.03) {
    if (!Number.isFinite(attendeeUsdPerHour) || attendeeUsdPerHour < 0) throw new Error('invalid Attendee hourly price');
    if (!Number.isFinite(deepgramSttUsdPerMinute) || deepgramSttUsdPerMinute < 0 ||
        !Number.isFinite(deepgramTtsUsdPerThousandCharacters) || deepgramTtsUsdPerThousandCharacters < 0) {
      throw new Error('invalid Deepgram price');
    }
  }
  start(sessionId: string, provider: string, realtimeAudio = false): void {
    this.sessions.set(sessionId, { provider, startedAt: this.now(), ttsRequests: 0, ttsFailures: 0,
      deepgramSttAudioSeconds: 0, deepgramTtsCharacters: 0,
      createTasks: 0, codeLookups: 0, responseMs: [], speechMs: {
        chat_mirror: [], tts_synthesis: [], audio_submission: [], speech_submission: [],
      } });
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value!);
    if (realtimeAudio) this.sessions.get(sessionId)!.realtimeAudio = true;
  }
  recordTts(sessionId: string, success: boolean): void {
    const session = this.sessions.get(sessionId); if (!session) return;
    session.ttsRequests++; if (!success) session.ttsFailures++;
  }
  recordResponse(sessionId: string, durationMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isFinite(durationMs) || durationMs < 0) return;
    session.responseMs.push(Math.round(durationMs));
    if (session.responseMs.length > 200) session.responseMs.shift();
  }
  recordSpeechStage(sessionId: string, stage: SpeechStage, durationMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !SPEECH_STAGES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = session.speechMs[stage];
    samples.push(Math.round(durationMs));
    if (samples.length > 200) samples.shift();
  }
  recordExternalAction(sessionId: string, action: 'create_task' | 'code_lookup'): void {
    const session = this.sessions.get(sessionId); if (!session) return;
    if (action === 'create_task') session.createTasks++; else session.codeLookups++;
  }
  recordDeepgramSttBytes(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    session.deepgramSttAudioSeconds += bytes / 32_000;
  }
  recordDeepgramTtsCharacters(sessionId: string, characters: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isSafeInteger(characters) || characters <= 0) return;
    session.deepgramTtsCharacters += characters;
  }
  end(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.endedAt === undefined) session.endedAt = this.now();
  }
  report(sessionId: string, ai?: AiUsage): SessionUsageReport | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const active = session.endedAt === undefined;
    const durationSeconds = Math.max(0, Math.round(((session.endedAt ?? this.now()) - session.startedAt) / 1000));
    const meetingEstimatedUsd = session.provider === 'attendee'
      ? Number((durationSeconds / 3600 * this.attendeeUsdPerHour).toFixed(6)) : 0;
    const deepgramEstimatedUsd = session.realtimeAudio
      ? Number((session.deepgramSttAudioSeconds / 60 * this.deepgramSttUsdPerMinute +
        session.deepgramTtsCharacters / 1000 * this.deepgramTtsUsdPerThousandCharacters).toFixed(6)) : 0;
    const totalEstimatedUsd = Number((meetingEstimatedUsd + deepgramEstimatedUsd + (ai?.estimatedUsd ?? 0)).toFixed(6));
    const durations = [...session.responseMs].sort((a, b) => a - b);
    const summarize = (values: readonly number[]): LatencySummary => {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? 0 };
    };
    const speechLatency: Record<SpeechStage, LatencySummary> = {
      chat_mirror: summarize(session.speechMs.chat_mirror),
      tts_synthesis: summarize(session.speechMs.tts_synthesis),
      audio_submission: summarize(session.speechMs.audio_submission),
      speech_submission: summarize(session.speechMs.speech_submission),
    };
    return { sessionId, provider: session.provider, active, durationSeconds,
      ...(session.provider === 'attendee' ? {
        transcriptionMode: session.realtimeAudio
          ? 'realtime_nova3_per_speaker' as const : 'closed_captions' as const,
        speechPipeline: session.realtimeAudio
          ? 'deepgram_aura_stream' as const : 'closed_captions_mp3' as const,
      } : {}),
      meetingEstimatedUsd, deepgramEstimatedUsd,
      ...(session.realtimeAudio ? { deepgramUsage: {
        sttAudioSeconds: Number(session.deepgramSttAudioSeconds.toFixed(3)),
        ttsCharacters: session.deepgramTtsCharacters,
      } } : {}),
      tts: { requests: session.ttsRequests, failures: session.ttsFailures },
      externalActions: { create_task: session.createTasks, code_lookup: session.codeLookups },
      ...(ai ? { ai } : {}), totalEstimatedUsd,
      processingLatency: summarize(durations),
      speechLatency };
  }
}
