/**
 * Audit log: every write Nogita makes to Jira, Slack or GitHub, one JSON line each in NOGITA_STATE_DIR/audit/writes.jsonl.
 * A line holds who asked, from which meeting, Slack thread or mission, what was sent, and the result (the receipt or
 * the error). The file is only ever appended to; reading it back is for the admin endpoint (/audit).
 *
 * What was sent is what left the building (a task title and description, a message), so it is kept, shortened.
 * Nothing else from the meeting (no transcript) is written here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WriteAudit } from '../core/agent-tools.ts';

export interface AuditEntry extends WriteAudit {
  at: string;
  /** Where the request came from, read from the session id. */
  origin: { kind: 'meeting' | 'slack' | 'mission' | 'system'; id: string };
}

const MAX_TEXT = 2_000;

/** A Slack thread is "slack:<channel>:<ts>", a mission "mission-M-...", anything else a meeting. */
export function originOf(sessionId: string): AuditEntry['origin'] {
  if (sessionId.startsWith('mission-')) return { kind: 'mission', id: sessionId.slice('mission-'.length) };
  if (sessionId.startsWith('slack:')) return { kind: 'slack', id: sessionId.slice('slack:'.length) };
  if (sessionId.startsWith('system:')) return { kind: 'system', id: sessionId.slice('system:'.length) };
  return { kind: 'meeting', id: sessionId };
}

function shorten(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(shorten);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item)]));
  return value;
}

export class FileAuditLog {
  readonly file: string;

  constructor(stateDirectory: string, private readonly now: () => number = Date.now) {
    const directory = join(resolve(stateDirectory), 'audit');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'writes.jsonl');
  }

  /** Appends one write, synchronously, so a crash right after a write still leaves its line. Never throws. */
  record(write: WriteAudit): void {
    const entry: AuditEntry = { at: new Date(this.now()).toISOString(), origin: originOf(write.sessionId), ...write,
      sent: shorten(write.sent) as Record<string, unknown> };
    try { appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }); }
    catch (error) { console.error('audit_log_write_failed', error instanceof Error ? error.message : 'unknown'); }
  }

  /** The latest entries, newest first, optionally since an ISO time or for one actor or origin. */
  read(filter: { limit?: number; since?: string; actorId?: string; origin?: string } = {}): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 1_000);
    const entries: AuditEntry[] = [];
    const lines = readFileSync(this.file, 'utf8').split('\n');
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index--) {
      let entry: AuditEntry;
      // A line cut short by a crash is not an entry.
      try { entry = JSON.parse(lines[index]!) as AuditEntry; } catch { continue; }
      if (filter.since && entry.at < filter.since) break;
      if (filter.actorId && entry.actor.id !== filter.actorId) continue;
      if (filter.origin && `${entry.origin.kind}:${entry.origin.id}` !== filter.origin && entry.origin.id !== filter.origin) continue;
      entries.push(entry);
    }
    return entries;
  }
}
