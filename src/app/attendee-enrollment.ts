export interface AttendeeEnrollmentCandidate {
  attendeeUserUuid: string;
  observedAt: number;
}

interface CandidateEntry extends AttendeeEnrollmentCandidate { sequence: number }

/** Short-lived, memory-only discovery of stable provider identities. */
export class AttendeeEnrollmentCandidates {
  private readonly entries = new Map<string, CandidateEntry>();
  private readonly maxCandidates: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: { maxCandidates?: number; retentionMs?: number; now?: () => number } = {}) {
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 20);
    this.retentionMs = Math.max(1, options.retentionMs ?? 60 * 60_000);
    this.now = options.now ?? Date.now;
  }

  observe(value: string): void {
    const attendeeUserUuid = value.trim();
    if (!attendeeUserUuid || attendeeUserUuid.length > 500) throw new Error('invalid Attendee user UUID');
    this.prune();
    this.entries.set(attendeeUserUuid, { attendeeUserUuid, observedAt: this.now(), sequence: ++this.sequence });
    const sorted = this.sorted();
    for (const item of sorted.slice(this.maxCandidates)) this.entries.delete(item.attendeeUserUuid);
  }

  list(): AttendeeEnrollmentCandidate[] {
    this.prune();
    return this.sorted().map(({ attendeeUserUuid, observedAt }) => ({ attendeeUserUuid, observedAt }));
  }

  private sorted(): CandidateEntry[] {
    return [...this.entries.values()].sort((a, b) => b.observedAt - a.observedAt || b.sequence - a.sequence);
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, entry] of this.entries) if (entry.observedAt < cutoff) this.entries.delete(key);
  }
}
