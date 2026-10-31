import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActionReceipt } from '../core/contracts.ts';

interface ReceiptOptions {
  retentionMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function digest(key: string): string {
  return createHash('sha256').update('action-receipt').update('\0').update(key).digest('hex');
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isReceipt(value: unknown): value is ActionReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.provider === 'string' && typeof receipt.url === 'string' && typeof receipt.label === 'string' &&
    (receipt.kind === 'task' || receipt.kind === 'code_lookup' || receipt.kind === 'draft_pr' || receipt.kind === 'message');
}

/**
 * The receipts of writes that already happened, kept on disk so a retried event or a restarted process does not
 * write them again. A drop-in for the engine's in-memory map: reads are from memory, every set and delete is written
 * through before it returns. Files are named by a hash of the key; each holds the key and the receipt (provider,
 * kind, link and label), no request or transcript text.
 */
export class FileActionReceipts extends Map<string, ActionReceipt> {
  private readonly directory: string;
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(root: string, options: ReceiptOptions = {}) {
    super();
    if (!root.trim()) throw new Error('action receipts root is required');
    this.directory = join(resolve(root), 'action-receipts');
    this.retentionMs = Math.max(60_000, options.retentionMs ?? 7 * 24 * 60 * 60_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 5000);
    this.clock = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true });
    const cutoff = this.clock() - this.retentionMs;
    const kept: Array<{ file: string; key: string; receipt: ActionReceipt; at: number }> = [];
    for (const file of readdirSync(this.directory)) {
      const path = join(this.directory, file);
      if (file.endsWith('.tmp')) { this.remove(path); continue; }
      if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as { key?: unknown; receipt?: unknown; at?: unknown };
        const at = typeof saved.at === 'number' ? saved.at : statSync(path).mtimeMs;
        if (typeof saved.key !== 'string' || !isReceipt(saved.receipt) || at < cutoff || `${digest(saved.key)}.json` !== file) {
          this.remove(path);
          continue;
        }
        kept.push({ file, key: saved.key, receipt: saved.receipt, at });
      } catch (error) {
        if (missing(error)) continue;
        // A half-written or foreign file is not a receipt; it never blocks the others.
        this.remove(path);
      }
    }
    kept.sort((a, b) => b.at - a.at);
    for (const old of kept.slice(this.maxEntries)) this.remove(join(this.directory, old.file));
    for (const entry of kept.slice(0, this.maxEntries).reverse()) super.set(entry.key, entry.receipt);
  }

  override set(key: string, receipt: ActionReceipt): this {
    if (!key || key.length > 4000) throw new Error('invalid action receipt key');
    const path = join(this.directory, `${digest(key)}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ key, receipt, at: this.clock() }));
    renameSync(temporary, path);
    super.delete(key);
    super.set(key, receipt);
    while (this.size > this.maxEntries) {
      const oldest = this.keys().next().value as string;
      this.delete(oldest);
    }
    return this;
  }

  override delete(key: string): boolean {
    this.remove(join(this.directory, `${digest(key)}.json`));
    return super.delete(key);
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }

  private remove(path: string): void {
    try { unlinkSync(path); } catch (error) { if (!missing(error)) throw error; }
  }
}
