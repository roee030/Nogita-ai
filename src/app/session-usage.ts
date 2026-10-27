import type { AiUsage, UsagePort } from '../core/contracts.ts';

interface SessionTiming {
  provider: string; startedAt: number; endedAt?: number;
  ttsRequests: number; ttsFailures: number; createTasks: number; codeLookups: number;
  responseMs: number[];
}
export interface SessionUsageReport {
  sessionId: string;
  provider: string;
  active: boolean;
  durationSeconds: number;
  transcriptionMode?: 'closed_captions';
  meetingEstimatedUsd: number;
  tts: { requests: number; failures: number };
  externalActions: { create_task: number; code_lookup: number };
  ai?: AiUsage;
  totalEstimatedUsd: number;
  processingLatency: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
}

export class SessionUsageRegistry implements UsagePort {
  private readonly sessions = new Map<string, SessionTiming>();
  constructor(private readonly attendeeUsdPerHour = 0.50, private readonly now = Date.now) {
    if (!Number.isFinite(attendeeUsdPerHour) || attendeeUsdPerHour < 0) throw new Error('invalid Attendee hourly price');
  }
  start(sessionId: string, provider: string): void {
    this.sessions.set(sessionId, { provider, startedAt: this.now(), ttsRequests: 0, ttsFailures: 0,
      createTasks: 0, codeLookups: 0, responseMs: [] });
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value!);
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
  recordExternalAction(sessionId: string, action: 'create_task' | 'code_lookup'): void {
    const session = this.sessions.get(sessionId); if (!session) return;
    if (action === 'create_task') session.createTasks++; else session.codeLookups++;
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
    const totalEstimatedUsd = Number((meetingEstimatedUsd + (ai?.estimatedUsd ?? 0)).toFixed(6));
    const durations = [...session.responseMs].sort((a, b) => a - b);
    const percentile = (p: number) => durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? 0;
    return { sessionId, provider: session.provider, active, durationSeconds,
      ...(session.provider === 'attendee' ? { transcriptionMode: 'closed_captions' as const } : {}),
      meetingEstimatedUsd, tts: { requests: session.ttsRequests, failures: session.ttsFailures },
      externalActions: { create_task: session.createTasks, code_lookup: session.codeLookups },
      ...(ai ? { ai } : {}), totalEstimatedUsd,
      processingLatency: { samples: durations.length, p50Ms: percentile(0.5),
        p95Ms: percentile(0.95), maxMs: durations.at(-1) ?? 0 } };
  }
}
