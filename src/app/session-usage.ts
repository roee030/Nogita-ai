import type { AiUsage } from '../core/contracts.ts';

interface SessionTiming { provider: string; startedAt: number; endedAt?: number }
export interface SessionUsageReport {
  sessionId: string;
  provider: string;
  active: boolean;
  durationSeconds: number;
  meetingEstimatedUsd: number;
  ai?: AiUsage;
  totalEstimatedUsd: number;
}

export class SessionUsageRegistry {
  private readonly sessions = new Map<string, SessionTiming>();
  constructor(private readonly attendeeUsdPerHour = 0.50, private readonly now = Date.now) {
    if (!Number.isFinite(attendeeUsdPerHour) || attendeeUsdPerHour < 0) throw new Error('invalid Attendee hourly price');
  }
  start(sessionId: string, provider: string): void {
    this.sessions.set(sessionId, { provider, startedAt: this.now() });
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value!);
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
    return { sessionId, provider: session.provider, active, durationSeconds, meetingEstimatedUsd,
      ...(ai ? { ai } : {}), totalEstimatedUsd };
  }
}
