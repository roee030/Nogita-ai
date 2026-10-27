import type { EncryptedFileEventQueue, QueuedProviderEvent } from './durable-event-queue.ts';

export class EventWorker {
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<Promise<void>>();
  constructor(private readonly queue: EncryptedFileEventQueue,
    private readonly handle: (item: QueuedProviderEvent) => Promise<void>,
    private readonly options: { intervalMs?: number; concurrency?: number; onError?: (error: unknown) => void } = {}) {}

  async processOnce(): Promise<'empty' | 'completed' | 'retried'> {
    const claim = await this.queue.claimNext();
    if (!claim) return 'empty';
    try {
      await this.handle(claim.item);
      await claim.complete();
      return 'completed';
    } catch (error) {
      await claim.retry();
      this.options.onError?.(error);
      return 'retried';
    }
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      const concurrency = Math.max(1, this.options.concurrency ?? 1);
      while (this.running.size < concurrency) {
        let work!: Promise<void>;
        work = this.processOnce().then(() => undefined).catch(error => this.options.onError?.(error))
          .finally(() => { this.running.delete(work); });
        this.running.add(work);
      }
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 250);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.running]);
  }
}
