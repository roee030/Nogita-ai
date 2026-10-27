/** Tracks accepted asynchronous work so a graceful shutdown can drain it. */
export class InFlightWork {
  private readonly pending = new Set<Promise<void>>();
  private open = true;

  get size(): number { return this.pending.size; }
  get accepting(): boolean { return this.open; }

  track<T>(work: Promise<T>): void {
    if (!this.open) throw new Error('work tracker is shutting down');
    let observed!: Promise<void>;
    observed = work.then(() => undefined, () => undefined)
      .finally(() => { this.pending.delete(observed); });
    this.pending.add(observed);
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('positive drain timeout required');
    this.open = false;
    if (!this.pending.size) return true;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = Promise.all([...this.pending]).then(() => true as const);
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
