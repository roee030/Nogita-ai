import type { AiUsage, ExternalAction, ResponseStage, SpeechStage, UsagePort } from '../core/contracts.ts';

interface SessionTiming {
  provider: string; startedAt: number; endedAt?: number; realtimeAudio?: boolean;
  deepgramSttAudioSeconds: number; deepgramTtsCharacters: number;
  ttsRequests: number; ttsFailures: number; actions: Record<ExternalAction, number>;
  responseMs: number[];
  responseStageMs: Record<ResponseStage, number[]>;
  speechMs: Record<SpeechStage, number[]>;
  budgetStatus: SessionBudgetStatus;
  backgroundStops: Set<() => void>;
}
type LatencySummary = { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
type SessionBudgetStatus = 'ok' | 'warning' | 'exceeded';
type SessionBudgetReason = 'model_calls' | 'estimated_usd_per_hour';
export interface SessionBudgetOptions {
  enabled?: boolean;
  maxModelCalls: number;
  maxEstimatedUsdPerHour: number;
  warningRatio?: number;
  log?: (event: SessionBudgetEvent) => void;
}
export type SessionBudgetEvent = {
  type: 'session_budget_warning' | 'session_budget_exceeded';
  sessionId: string;
  reason?: SessionBudgetReason;
  modelCalls: number;
  maxModelCalls: number;
  estimatedUsdPerHour: number;
  maxEstimatedUsdPerHour: number;
};
export interface SessionBudgetReport {
  status: SessionBudgetStatus;
  reason?: SessionBudgetReason;
  modelCalls: number;
  maxModelCalls: number;
  estimatedUsdPerHour: number;
  maxEstimatedUsdPerHour: number;
}
const SPEECH_STAGES: readonly SpeechStage[] = ['chat_mirror', 'tts_synthesis', 'audio_submission', 'speech_submission'];
const RESPONSE_STAGES: readonly ResponseStage[] = ['transcript_to_chat_ack', 'model_roundtrip', 'turn_to_first_speech_attempt'];
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
  externalActions: Record<ExternalAction, number>;
  ai?: AiUsage;
  budget?: SessionBudgetReport;
  totalEstimatedUsd: number;
  processingLatency: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
  responseStages: Record<ResponseStage, LatencySummary>;
  speechLatency: Record<SpeechStage, LatencySummary>;
}

export class SessionUsageRegistry implements UsagePort {
  private readonly sessions = new Map<string, SessionTiming>();
  constructor(private readonly attendeeUsdPerHour = 0.50, private readonly now = Date.now,
    private readonly deepgramSttUsdPerMinute = 0.0058, private readonly deepgramTtsUsdPerThousandCharacters = 0.03,
    private readonly budget?: SessionBudgetOptions) {
    if (!Number.isFinite(attendeeUsdPerHour) || attendeeUsdPerHour < 0) throw new Error('invalid Attendee hourly price');
    if (!Number.isFinite(deepgramSttUsdPerMinute) || deepgramSttUsdPerMinute < 0 ||
        !Number.isFinite(deepgramTtsUsdPerThousandCharacters) || deepgramTtsUsdPerThousandCharacters < 0) {
      throw new Error('invalid Deepgram price');
    }
    if (budget?.enabled && (!Number.isSafeInteger(budget.maxModelCalls) || budget.maxModelCalls <= 0 ||
        !Number.isFinite(budget.maxEstimatedUsdPerHour) || budget.maxEstimatedUsdPerHour <= 0 ||
        !Number.isFinite(budget.warningRatio ?? 0.8) || (budget.warningRatio ?? 0.8) <= 0 ||
        (budget.warningRatio ?? 0.8) >= 1)) throw new Error('invalid session budget');
  }
  start(sessionId: string, provider: string, realtimeAudio = false): void {
    this.sessions.set(sessionId, { provider, startedAt: this.now(), ttsRequests: 0, ttsFailures: 0,
      deepgramSttAudioSeconds: 0, deepgramTtsCharacters: 0,
      actions: { create_task: 0, update_task: 0, draft_pr: 0, code_lookup: 0 }, responseMs: [], speechMs: {
        chat_mirror: [], tts_synthesis: [], audio_submission: [], speech_submission: [],
      }, responseStageMs: { transcript_to_chat_ack: [], model_roundtrip: [], turn_to_first_speech_attempt: [] },
      budgetStatus: 'ok', backgroundStops: new Set() });
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
  recordResponseStage(sessionId: string, stage: ResponseStage, durationMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !RESPONSE_STAGES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = session.responseStageMs[stage];
    samples.push(Math.round(durationMs));
    if (samples.length > 200) samples.shift();
  }
  recordSpeechStage(sessionId: string, stage: SpeechStage, durationMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !SPEECH_STAGES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = session.speechMs[stage];
    samples.push(Math.round(durationMs));
    if (samples.length > 200) samples.shift();
  }
  recordExternalAction(sessionId: string, action: ExternalAction): void {
    const session = this.sessions.get(sessionId); if (!session || !(action in session.actions)) return;
    session.actions[action]++;
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
  registerBackgroundWork(sessionId: string, stop: () => void): () => void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.budget?.enabled) return () => undefined;
    if (session.budgetStatus === 'exceeded') {
      stop();
      return () => undefined;
    }
    session.backgroundStops.add(stop);
    return () => { session.backgroundStops.delete(stop); };
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
    const budget = this.evaluateBudget(sessionId, session, durationSeconds, totalEstimatedUsd, ai?.modelCalls ?? 0);
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
      externalActions: { ...session.actions },
      ...(ai ? { ai } : {}), ...(budget ? { budget } : {}), totalEstimatedUsd,
      processingLatency: summarize(durations),
      responseStages: {
        transcript_to_chat_ack: summarize(session.responseStageMs.transcript_to_chat_ack),
        model_roundtrip: summarize(session.responseStageMs.model_roundtrip),
        turn_to_first_speech_attempt: summarize(session.responseStageMs.turn_to_first_speech_attempt),
      },
      speechLatency };
  }

  private evaluateBudget(sessionId: string, session: SessionTiming, durationSeconds: number,
    totalEstimatedUsd: number, modelCalls: number): SessionBudgetReport | undefined {
    if (!this.budget?.enabled) return undefined;
    const estimatedUsdPerHour = durationSeconds === 0
      ? (totalEstimatedUsd === 0 ? 0 : Number.POSITIVE_INFINITY)
      : Number((totalEstimatedUsd * 3600 / durationSeconds).toFixed(6));
    const reason: SessionBudgetReason | undefined = modelCalls > this.budget.maxModelCalls ? 'model_calls'
      : estimatedUsdPerHour > this.budget.maxEstimatedUsdPerHour ? 'estimated_usd_per_hour' : undefined;
    const warningRatio = this.budget.warningRatio ?? 0.8;
    const status: SessionBudgetStatus = reason ? 'exceeded'
      : modelCalls >= this.budget.maxModelCalls * warningRatio ||
        estimatedUsdPerHour >= this.budget.maxEstimatedUsdPerHour * warningRatio ? 'warning' : 'ok';
    const report: SessionBudgetReport = { status, ...(reason ? { reason } : {}), modelCalls,
      maxModelCalls: this.budget.maxModelCalls, estimatedUsdPerHour,
      maxEstimatedUsdPerHour: this.budget.maxEstimatedUsdPerHour };
    if (status !== session.budgetStatus) {
      const eventUsage = { modelCalls, maxModelCalls: this.budget.maxModelCalls, estimatedUsdPerHour,
        maxEstimatedUsdPerHour: this.budget.maxEstimatedUsdPerHour };
      if (status === 'warning') this.budget.log?.({ type: 'session_budget_warning', sessionId, ...eventUsage });
      if (status === 'exceeded') {
        this.budget.log?.({ type: 'session_budget_exceeded', sessionId, reason: reason!, ...eventUsage });
        for (const stop of session.backgroundStops) {
          try { stop(); } catch { /* one failed cleanup must not leave the other work running */ }
        }
        session.backgroundStops.clear();
      }
      session.budgetStatus = status;
    }
    return report;
  }
}
