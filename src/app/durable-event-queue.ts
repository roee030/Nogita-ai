import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type QueueNamespace = 'slack' | 'attendee';
export interface QueuedProviderEvent {
  namespace: QueueNamespace;
  payload: string;
  attempts: number;
  createdAt: number;
  availableAt?: number;
}
export interface QueueClaim {
  item: QueuedProviderEvent;
  complete(): Promise<void>;
  retry(): Promise<void>;
}
interface QueueOptions {
  leaseMs?: number;
  maxCompleted?: number;
  maxQueued?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => number;
}
interface EncryptedRecord { v: 1; iv: string; tag: string; ciphertext: string }

function absent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
function exists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

/** Encrypted, bounded, restart-safe provider delivery queue for a shared persistent filesystem. */
export class EncryptedFileEventQueue {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly leaseMs: number;
  private readonly maxCompleted: number;
  private readonly maxQueued: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;

  constructor(root: string, keyBase64: string, options: QueueOptions = {}) {
    if (!root.trim()) throw new Error('event queue root is required');
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('event queue encryption key must be 32 base64-encoded bytes');
    this.directory = join(resolve(root), 'event-queue');
    this.leaseMs = Math.max(10, options.leaseMs ?? 5 * 60_000);
    this.maxCompleted = Math.max(1, options.maxCompleted ?? 5000);
    this.maxQueued = Math.max(1, options.maxQueued ?? 1000);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 8);
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1000);
    this.now = options.now ?? Date.now;
  }

  private digest(namespace: QueueNamespace, eventId: string): string {
    return createHmac('sha256', this.key).update(namespace).update('\0').update(eventId).digest('hex');
  }

  private encrypt(item: QueuedProviderEvent, digest: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(digest));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(item), 'utf8'), cipher.final()]);
    const record: EncryptedRecord = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64') };
    return JSON.stringify(record);
  }

  private decrypt(raw: string, digest: string): QueuedProviderEvent {
    try {
      const record = JSON.parse(raw) as EncryptedRecord;
      if (record.v !== 1 || !record.iv || !record.tag || !record.ciphertext) throw new Error('invalid record');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(digest));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
      const item = JSON.parse(plaintext.toString('utf8')) as QueuedProviderEvent;
      if ((item.namespace !== 'slack' && item.namespace !== 'attendee') || typeof item.payload !== 'string' ||
          !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isFinite(item.createdAt) ||
          (item.availableAt !== undefined && !Number.isFinite(item.availableAt))) {
        throw new Error('invalid record');
      }
      return item;
    } catch {
      throw new Error('event queue record authentication failed');
    }
  }

  async enqueue(namespace: QueueNamespace, eventId: string, payload: string): Promise<'queued' | 'duplicate'> {
    if (!eventId || eventId.length > 500) throw new Error('invalid event ID');
    if (!payload || Buffer.byteLength(payload) > 256 * 1024) throw new Error('invalid event payload');
    await mkdir(this.directory, { recursive: true });
    await this.prune();
    const digest = this.digest(namespace, eventId);
    const recordPath = join(this.directory, `${digest}.record`);
    const donePath = join(this.directory, `${digest}.done`);
    const names = await readdir(this.directory);
    if (names.includes(`${digest}.record`) || names.includes(`${digest}.done`)) return 'duplicate';
    if (names.filter(name => name.endsWith('.record')).length >= this.maxQueued) throw new Error('event queue is full');
    const tempPath = join(this.directory, `${digest}.${randomBytes(8).toString('hex')}.tmp`);
    const createdAt = this.now();
    await writeFile(tempPath, this.encrypt({ namespace, payload, attempts: 0, createdAt, availableAt: createdAt }, digest),
      { flag: 'wx', flush: true });
    try {
      try { await link(tempPath, recordPath); }
      catch (error) { if (exists(error)) return 'duplicate'; throw error; }
      try { await stat(donePath); return 'duplicate'; }
      catch (error) { if (!absent(error)) throw error; }
      return 'queued';
    } finally {
      try { await unlink(tempPath); } catch (error) { if (!absent(error)) throw error; }
    }
  }

  async claimNext(): Promise<QueueClaim | null> {
    await mkdir(this.directory, { recursive: true });
    await this.recoverStaleLeases();
    const records = (await readdir(this.directory)).filter(name => /^[0-9a-f]{64}\.record$/.test(name));
    const candidates: Array<{ name: string; digest: string; item: QueuedProviderEvent }> = [];
    for (const name of records) {
      const digest = name.slice(0, 64);
      const recordPath = join(this.directory, name);
      const leasePath = join(this.directory, `${digest}.lease`);
      try { candidates.push({ name, digest, item: this.decrypt(await readFile(recordPath, 'utf8'), digest) }); }
      catch (error) {
        let quarantine;
        try { quarantine = await open(leasePath, 'wx'); }
        catch (leaseError) { if (exists(leaseError)) continue; throw leaseError; }
        await quarantine.close();
        try { await rename(recordPath, join(this.directory, `${digest}.dead`)); }
        catch (moveError) { if (!absent(moveError)) throw moveError; }
        try { await unlink(leasePath); } catch (removeError) { if (!absent(removeError)) throw removeError; }
        throw error;
      }
    }
    const now = this.now();
    candidates.sort((a, b) => (a.item.availableAt ?? a.item.createdAt) - (b.item.availableAt ?? b.item.createdAt) ||
      a.item.createdAt - b.item.createdAt || a.digest.localeCompare(b.digest));
    for (const candidate of candidates) {
      const { name, digest, item } = candidate;
      if ((item.availableAt ?? item.createdAt) > now) continue;
      const recordPath = join(this.directory, name);
      const leasePath = join(this.directory, `${digest}.lease`);
      let handle;
      try { handle = await open(leasePath, 'wx'); }
      catch (error) { if (exists(error)) continue; throw error; }
      await handle.close();
      let settled = false;
      return {
        item,
        complete: async () => {
          if (settled) return; settled = true;
          const done = await open(join(this.directory, `${digest}.done`), 'a'); await done.close();
          try { await unlink(recordPath); } catch (error) { if (!absent(error)) throw error; }
          try { await unlink(leasePath); } catch (error) { if (!absent(error)) throw error; }
          await this.prune();
        },
        retry: async () => {
          if (settled) return; settled = true;
          const attempts = item.attempts + 1;
          if (attempts >= this.maxAttempts) {
            try { await rename(recordPath, join(this.directory, `${digest}.dead`)); }
            finally { try { await unlink(leasePath); } catch (error) { if (!absent(error)) throw error; } }
            return;
          }
          const tempPath = join(this.directory, `${digest}.${randomBytes(8).toString('hex')}.tmp`);
          const delay = Math.min(60_000, this.retryBaseMs * 2 ** item.attempts);
          await writeFile(tempPath, this.encrypt({ ...item, attempts, availableAt: this.now() + delay }, digest),
            { flag: 'wx', flush: true });
          try { await rename(tempPath, recordPath); }
          finally {
            try { await unlink(tempPath); } catch (error) { if (!absent(error)) throw error; }
            try { await unlink(leasePath); } catch (error) { if (!absent(error)) throw error; }
          }
        },
      };
    }
    return null;
  }

  private async recoverStaleLeases(): Promise<void> {
    const now = this.now();
    for (const name of (await readdir(this.directory)).filter(name => /^[0-9a-f]{64}\.lease$/.test(name))) {
      const path = join(this.directory, name);
      try { if (now - (await stat(path)).mtimeMs > this.leaseMs) await unlink(path); }
      catch (error) { if (!absent(error)) throw error; }
    }
  }

  private async prune(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    const retained = await Promise.all(names.filter(name => name.endsWith('.done') || name.endsWith('.dead')).map(async name => ({
      name, mtime: (await stat(join(this.directory, name))).mtimeMs,
    })));
    for (const suffix of ['.done', '.dead']) {
      for (const entry of retained.filter(item => item.name.endsWith(suffix))
        .sort((a, b) => b.mtime - a.mtime).slice(this.maxCompleted)) {
        try { await unlink(join(this.directory, entry.name)); } catch (error) { if (!absent(error)) throw error; }
      }
    }
    const cutoff = this.now() - 24 * 60 * 60_000;
    for (const name of names.filter(name => name.endsWith('.tmp'))) {
      const path = join(this.directory, name);
      try { if ((await stat(path)).mtimeMs < cutoff) await unlink(path); }
      catch (error) { if (!absent(error)) throw error; }
    }
  }
}
