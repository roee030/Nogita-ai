interface ConversationState {
  lastUsedAt: number;
  activeWork: number;
}

export interface SlackConversationLease {
  release(): void;
}

/** Bounded, idle-expiring in-memory lifecycle for Slack thread contexts. */
export class SlackConversationRegistry {
  private readonly conversations = new Map<string, ConversationState>();

  constructor(
    private readonly maxConversations = 500,
    private readonly idleMs = 30 * 60_000,
    private readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(maxConversations) || maxConversations < 1 ||
        !Number.isFinite(idleMs) || idleMs < 1) throw new Error('invalid Slack conversation limits');
  }

  get size(): number { return this.conversations.size; }

  isActive(sessionId: string): boolean {
    return (this.conversations.get(sessionId)?.activeWork ?? 0) > 0;
  }

  enter(sessionId: string): SlackConversationLease {
    if (!sessionId || sessionId.length > 300) throw new Error('invalid Slack session ID');
    let state = this.conversations.get(sessionId);
    if (!state) {
      state = { lastUsedAt: this.now(), activeWork: 0 };
      this.conversations.set(sessionId, state);
    }
    state.lastUsedAt = this.now();
    state.activeWork++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      if (this.conversations.get(sessionId) !== state) return;
      state!.activeWork = Math.max(0, state!.activeWork - 1);
      state!.lastUsedAt = this.now();
    } };
  }

  cleanupCandidates(at = this.now(), reserveSlots = 0): string[] {
    if (!Number.isFinite(at) || !Number.isSafeInteger(reserveSlots) || reserveSlots < 0)
      throw new Error('invalid Slack cleanup request');
    const idle = [...this.conversations.entries()]
      .filter(([, state]) => state.activeWork === 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[0].localeCompare(b[0]));
    const expired = idle.filter(([, state]) => at - state.lastUsedAt >= this.idleMs);
    const needed = Math.max(0, this.conversations.size + reserveSlots - this.maxConversations);
    const selected = new Set(expired.map(([id]) => id));
    for (const [id] of idle) {
      if (selected.size >= Math.max(expired.length, needed)) break;
      selected.add(id);
    }
    return idle.filter(([id]) => selected.has(id)).map(([id]) => id);
  }

  forget(sessionId: string): boolean {
    const state = this.conversations.get(sessionId);
    if (!state || state.activeWork > 0) return false;
    return this.conversations.delete(sessionId);
  }
}
