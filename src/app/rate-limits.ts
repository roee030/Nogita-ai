/**
 * Rate limits (NOGITA_RATE_LIMITS): caps on writes (tasks, messages, draft PRs) and model calls, per person over the
 * last hour and per meeting over its whole length. Past a cap nothing is done and she says which cap it was and when
 * it frees up. Counters (how often each cap was hit, who is near one) are in readiness.
 *
 *   NOGITA_RATE_WRITES_PER_PERSON_HOUR   30     NOGITA_RATE_MODEL_CALLS_PER_PERSON_HOUR   300
 *   NOGITA_RATE_WRITES_PER_MEETING       60     NOGITA_RATE_MODEL_CALLS_PER_MEETING       600
 */
import type { LimitsPort } from '../core/agent-tools.ts';

export interface RateLimitConfig {
  writesPerPersonHour: number;
  writesPerMeeting: number;
  modelCallsPerPersonHour: number;
  modelCallsPerMeeting: number;
}
export const DEFAULT_RATE_LIMITS: RateLimitConfig = { writesPerPersonHour: 30, writesPerMeeting: 60, modelCallsPerPersonHour: 300, modelCallsPerMeeting: 600 };

type Kind = 'write' | 'model_call';
const HOUR = 60 * 60_000;
const ENV: Record<keyof RateLimitConfig, string> = {
  writesPerPersonHour: 'NOGITA_RATE_WRITES_PER_PERSON_HOUR', writesPerMeeting: 'NOGITA_RATE_WRITES_PER_MEETING',
  modelCallsPerPersonHour: 'NOGITA_RATE_MODEL_CALLS_PER_PERSON_HOUR', modelCallsPerMeeting: 'NOGITA_RATE_MODEL_CALLS_PER_MEETING',
};

/** The limits from the environment, or undefined when NOGITA_RATE_LIMITS is not 'true'. */
export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig | undefined {
  const flag = env.NOGITA_RATE_LIMITS?.trim() ?? '';
  if (!['', 'true', 'false'].includes(flag)) throw new Error('NOGITA_RATE_LIMITS must be true or false');
  if (flag !== 'true') return undefined;
  const config = { ...DEFAULT_RATE_LIMITS };
  for (const [key, name] of Object.entries(ENV) as Array<[keyof RateLimitConfig, string]>) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a whole number of at least 1`);
    config[key] = value;
  }
  return config;
}

export interface RateLimitCounters {
  limits: RateLimitConfig;
  /** How often each cap refused something since the start. */
  refused: { writesPerPerson: number; writesPerMeeting: number; modelCallsPerPerson: number; modelCallsPerMeeting: number };
  /** People at 80% or more of a per-person cap in the last hour, and meetings at 80% or more of theirs. */
  near: Array<{ kind: Kind; scope: 'person' | 'meeting'; id: string; used: number; limit: number }>;
}

export class RateLimiter implements LimitsPort {
  private readonly people = new Map<string, number[]>();
  private readonly meetings = new Map<string, number>();
  private readonly refused = { writesPerPerson: 0, writesPerMeeting: 0, modelCallsPerPerson: 0, modelCallsPerMeeting: 0 };

  constructor(readonly limits: RateLimitConfig = DEFAULT_RATE_LIMITS, private readonly now: () => number = Date.now,
    private readonly onRefused?: (kind: Kind, scope: 'person' | 'meeting', who: { actorId: string; sessionId: string }) => void) {}

  take(kind: Kind, who: { actorId: string; sessionId: string }): string | undefined {
    const at = this.now();
    const personKey = `${kind}:${who.actorId}`;
    // A mission belongs to its owner, not to a meeting: only the per-person cap applies to it.
    const meetingKey = who.sessionId.startsWith('mission-') ? undefined : `${kind}:${who.sessionId}`;
    const recent = (this.people.get(personKey) ?? []).filter(time => at - time < HOUR);
    const perPerson = kind === 'write' ? this.limits.writesPerPersonHour : this.limits.modelCallsPerPersonHour;
    const perMeeting = kind === 'write' ? this.limits.writesPerMeeting : this.limits.modelCallsPerMeeting;
    const what = kind === 'write' ? 'changes' : 'requests';
    if (meetingKey && (this.meetings.get(meetingKey) ?? 0) >= perMeeting) {
      this.refused[kind === 'write' ? 'writesPerMeeting' : 'modelCallsPerMeeting']++;
      this.onRefused?.(kind, 'meeting', who);
      return kind === 'write'
        ? `I've made the ${perMeeting} changes I'm allowed in one meeting, so I didn't make this one. I can do it from Slack after the meeting.`
        : `I've reached my limit for this meeting, so I'll stop answering here. You can ask me in Slack.`;
    }
    if (recent.length >= perPerson) {
      this.people.set(personKey, recent);
      this.refused[kind === 'write' ? 'writesPerPerson' : 'modelCallsPerPerson']++;
      this.onRefused?.(kind, 'person', who);
      const minutes = Math.max(1, Math.ceil((recent[0]! + HOUR - at) / 60_000));
      return `You've reached the limit of ${perPerson} ${what} an hour, so I didn't do that. It frees up in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    recent.push(at);
    this.people.set(personKey, recent);
    if (meetingKey) this.meetings.set(meetingKey, (this.meetings.get(meetingKey) ?? 0) + 1);
    return undefined;
  }

  /** A meeting that ended frees its counter. */
  endMeeting(sessionId: string): void {
    this.meetings.delete(`write:${sessionId}`);
    this.meetings.delete(`model_call:${sessionId}`);
  }

  counters(): RateLimitCounters {
    const at = this.now();
    const near: RateLimitCounters['near'] = [];
    for (const [key, times] of this.people) {
      const [kind, id] = split(key);
      const used = times.filter(time => at - time < HOUR).length;
      const limit = kind === 'write' ? this.limits.writesPerPersonHour : this.limits.modelCallsPerPersonHour;
      if (used >= limit * 0.8) near.push({ kind, scope: 'person', id, used, limit });
    }
    for (const [key, used] of this.meetings) {
      const [kind, id] = split(key);
      const limit = kind === 'write' ? this.limits.writesPerMeeting : this.limits.modelCallsPerMeeting;
      if (used >= limit * 0.8) near.push({ kind, scope: 'meeting', id, used, limit });
    }
    return { limits: this.limits, refused: { ...this.refused }, near };
  }
}

function split(key: string): [Kind, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index) as Kind, key.slice(index + 1)];
}
