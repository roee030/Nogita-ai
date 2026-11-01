/**
 * Provider health: a circuit breaker per provider (Jira, GitHub, Slack, Anthropic, Deepgram). After a few failures in a
 * row (or calls slower than `slowMs`) the provider is "down": calls fail at once with ProviderUnavailableError instead
 * of piling up retries and timeouts, and she says in one short line what is unavailable. After `cooldownMs` one call
 * is let through as a trial; when it works the provider is back, with no restart and nothing to reset by hand.
 */

export type ProviderId = 'jira' | 'github' | 'slack' | 'anthropic' | 'deepgram';
export type BreakerState = 'closed' | 'open' | 'half_open';

/** A provider is down; nothing was sent to it. `name` is how people know it ("Jira", "Slack"). */
export class ProviderUnavailableError extends Error {
  constructor(readonly provider: ProviderId, readonly providerName: string, readonly downForMs: number) {
    super(`${providerName} is not answering right now (down for ${Math.max(1, Math.round(downForMs / 1000))} s), so nothing was sent to it ` +
      `and it was not retried. Tell the person in one short sentence that ${providerName} is unavailable at the moment; do not guess what it would have said.`);
    this.name = 'ProviderUnavailableError';
  }
  /** What she says when she cannot answer at all (the model itself is down). */
  get spoken(): string {
    return this.provider === 'anthropic' ? 'Sorry, my thinking service is down right now, so I can’t answer that. Try me again in a minute.'
      : `Sorry, ${this.providerName} isn’t answering right now. Try me again in a minute.`;
  }
}

export interface BreakerOptions {
  /** Failures in a row that take a provider down. */
  failures?: number;
  /** How long it stays down before one trial call. */
  cooldownMs?: number;
  /** A call that took longer than this counts as a failure (it is not cut short: a write may have happened). */
  slowMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failuresInRow = 0;
  private openedAt?: number;
  private trial = false;
  private readonly now: () => number;

  constructor(readonly provider: ProviderId, readonly providerName: string, private readonly options: BreakerOptions = {},
    private readonly onChange?: (provider: ProviderId, state: BreakerState) => void) {
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openedAt === undefined) return 'closed';
    return this.trial || this.now() - this.openedAt >= (this.options.cooldownMs ?? 30_000) ? 'half_open' : 'open';
  }

  /** Runs one call, or refuses it at once while the provider is down (one trial call goes through after the cooldown). */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.openedAt !== undefined) {
      if (this.trial || this.state === 'open') throw new ProviderUnavailableError(this.provider, this.providerName, this.now() - this.openedAt);
      this.trial = true;
    }
    const started = this.now();
    try {
      const result = await work();
      if (this.now() - started > (this.options.slowMs ?? 20_000)) this.failure(); else this.success();
      return result;
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError) && !isCallerError(error)) this.failure();
      else if (this.trial) this.trial = false;
      throw error;
    }
  }

  success(): void {
    const wasDown = this.openedAt !== undefined;
    this.failuresInRow = 0;
    this.openedAt = undefined;
    this.trial = false;
    if (wasDown) this.onChange?.(this.provider, 'closed');
  }

  failure(): void {
    this.failuresInRow++;
    if (this.trial) {
      // The trial failed: down again for another cooldown.
      this.trial = false;
      this.openedAt = this.now();
      this.onChange?.(this.provider, 'open');
      return;
    }
    if (this.openedAt === undefined && this.failuresInRow >= (this.options.failures ?? 3)) {
      this.openedAt = this.now();
      this.onChange?.(this.provider, 'open');
    }
  }
}

/** An abort (a cancelled question) or a request the provider rightly refused is not the provider being down. */
function isCallerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class ProviderHealth {
  private readonly breakers = new Map<ProviderId, CircuitBreaker>();
  constructor(private readonly options: BreakerOptions = {}, private readonly onChange?: (provider: ProviderId, state: BreakerState) => void) {}

  breaker(provider: ProviderId, name: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) this.breakers.set(provider, breaker = new CircuitBreaker(provider, name, this.options, this.onChange));
    return breaker;
  }

  /** Each provider seen so far and whether it is up (closed), down (open) or on trial (half_open). */
  snapshot(): Partial<Record<ProviderId, BreakerState>> {
    return Object.fromEntries([...this.breakers].map(([provider, breaker]) => [provider, breaker.state]));
  }
}

/** The port with the named async methods run through the provider's breaker; everything else passes through. */
export function guardPort<P extends object>(port: P, breaker: CircuitBreaker, methods: ReadonlyArray<keyof P>): P {
  return new Proxy(port, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver);
    if (typeof value !== 'function') return value;
    if (!methods.includes(name as keyof P)) return value.bind(target);
    return (...args: unknown[]) => breaker.run(async () => await value.apply(target, args));
  } });
}
