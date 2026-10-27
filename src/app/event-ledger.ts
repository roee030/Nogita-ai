import { createHash } from 'node:crypto';
import { access, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface EventClaim {
  complete(): Promise<void>;
  abandon(): Promise<void>;
}

export type EventClaimResult =
  | { status: 'started'; claim: EventClaim }
  | { status: 'active' | 'completed' };

interface LedgerOptions {
  leaseMs?: number;
  retentionMs?: number;
  maxCompleted?: number;
  orphanRetentionMs?: number;
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function exists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

/** Persists only hashes of provider event IDs. No transcript or participant data is written. */
export class FileEventLedger {
  private readonly root: string;
  private readonly leaseMs: number;
  private readonly retentionMs: number;
  private readonly maxCompleted: number;
  private readonly orphanRetentionMs: number;

  constructor(root: string, options: LedgerOptions = {}) {
    if (!root.trim()) throw new Error('event ledger root is required');
    this.root = resolve(root);
    this.leaseMs = Math.max(10, options.leaseMs ?? 5 * 60_000);
    this.retentionMs = Math.max(60_000, options.retentionMs ?? 7 * 24 * 60 * 60_000);
    this.maxCompleted = Math.max(1, options.maxCompleted ?? 5000);
    this.orphanRetentionMs = Math.max(10, options.orphanRetentionMs ?? 24 * 60 * 60_000);
  }

  async begin(namespace: string, eventId: string): Promise<EventClaimResult> {
    if (!/^[a-z0-9_-]{1,32}$/.test(namespace)) throw new Error('invalid event namespace');
    if (!eventId || eventId.length > 500) throw new Error('invalid event ID');
    const directory = join(this.root, namespace);
    await mkdir(directory, { recursive: true });
    await this.prune(directory);
    const eventDigest = digest(namespace, eventId);
    const pending = join(directory, `${eventDigest}.pending`);
    const completed = join(directory, `${eventDigest}.done`);
    try {
      await access(completed);
      return { status: 'completed' };
    } catch (error) {
      if (!missing(error)) throw error;
    }

    try {
      const handle = await open(pending, 'wx');
      await handle.close();
    } catch (error) {
      if (!exists(error)) throw error;
      try {
        const info = await stat(pending);
        if (Date.now() - info.mtimeMs <= this.leaseMs) return { status: 'active' };
        await unlink(pending);
        return this.begin(namespace, eventId);
      } catch (staleError) {
        if (missing(staleError)) return this.begin(namespace, eventId);
        throw staleError;
      }
    }

    let settled = false;
    return {
      status: 'started',
      claim: {
        complete: async () => {
          if (settled) return;
          settled = true;
          await rename(pending, completed);
          await this.prune(directory);
        },
        abandon: async () => {
          if (settled) return;
          settled = true;
          try { await unlink(pending); } catch (error) { if (!missing(error)) throw error; }
        },
      },
    };
  }

  private async prune(directory: string): Promise<void> {
    const entries = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.(?:done|pending)$/.test(name));
    const found = await Promise.all(entries.map(async name => {
      try { return { name, info: await stat(join(directory, name)) }; }
      catch (error) { if (missing(error)) return null; throw error; }
    }));
    const files = found.filter((file): file is NonNullable<(typeof found)[number]> => file !== null);
    const now = Date.now();
    const done = files.filter(file => file.name.endsWith('.done'));
    const cutoff = now - this.retentionMs;
    const retained = done.filter(file => file.info.mtimeMs >= cutoff).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    const remove = [
      ...done.filter(file => file.info.mtimeMs < cutoff),
      ...retained.slice(this.maxCompleted),
      ...files.filter(file => file.name.endsWith('.pending') && file.info.mtimeMs < now - this.orphanRetentionMs),
    ];
    await Promise.all(remove.map(async file => {
      try { await unlink(join(directory, file.name)); } catch (error) { if (!missing(error)) throw error; }
    }));
  }
}

/** Persists membership of an Attendee bot/session pair as an empty, hashed marker. */
export class FileBindingRegistry {
  private readonly directory: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error('binding registry root is required');
    this.directory = join(resolve(root), 'attendee-bindings');
  }

  private path(sessionId: string, botId: string): string {
    if (!sessionId || sessionId.length > 100) throw new Error('invalid session ID');
    if (!/^bot_[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('invalid bot ID');
    return join(this.directory, `${digest('attendee-binding', sessionId, botId)}.binding`);
  }

  async register(sessionId: string, botId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const handle = await open(this.path(sessionId, botId), 'a');
    await handle.close();
  }

  async has(sessionId: string, botId: string): Promise<boolean> {
    try { await access(this.path(sessionId, botId)); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }

  async remove(sessionId: string, botId: string): Promise<void> {
    try { await unlink(this.path(sessionId, botId)); }
    catch (error) { if (!missing(error)) throw error; }
  }
}
