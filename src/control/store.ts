/**
 * The control plane's record of each company: who its members are, which tools it connected, its own provider keys,
 * its people, and its cell. Never meeting content, code or tasks. Every secret in it is sealed by the vault.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sealed } from './vault.ts';

export type Role = 'admin' | 'member';
export interface Member { email: string; name?: string; role: Role }

/** The company's own accounts with the vendors Nogita runs on; it pays them directly. */
export interface CompanyKeys { anthropic?: Sealed; deepgram?: Sealed; attendee?: Sealed; attendeeWebhookSecret?: Sealed }

export type Connection =
  | { id: string; kind: 'slack'; teamId: string; teamName: string; botUserId: string; botToken: Sealed; connectedBy: string }
  | { id: string; kind: 'jira'; cloudId: string; siteUrl: string; siteName: string; projectKey?: string; readProjectKeys?: string[];
      accessToken: Sealed; refreshToken: Sealed; expiresAt: number; connectedBy: string }
  | { id: string; kind: 'github'; installationId: number; account: string;
      repositories: Array<{ owner: string; repo: string; ref: string }>; connectedBy: string };

/** Someone on the team: matched across tools by email. Only `authorized` people may ask Nogita for changes. */
export interface Person { id: string; displayName: string; email: string; slack?: { teamId: string; userId: string };
  authorized: boolean }

export interface Cell {
  provider: 'render';
  serviceId: string;
  url: string;
  status: 'provisioning' | 'live' | 'failed' | 'deleting';
  /** Only the hash: the cell presents the token to the broker. */
  cellTokenHash: string;
  /** The cell's own secrets, generated here: it never shares a key with another company's cell. */
  secrets: { adminToken: Sealed; queueKey: Sealed; cellToken: Sealed; slackSigningSecret: Sealed };
  /** Hash of the configuration last sent, to know when the cell needs an update. */
  configHash?: string;
  updatedAt: string;
}

export interface Company {
  id: string;
  name: string;
  createdAt: string;
  members: Member[];
  keys: CompanyKeys;
  /** The company confirmed it reviewed recording people in meetings (the cell's ATTENDEE_PRIVACY_REVIEWED). */
  meetingPrivacyReviewed: boolean;
  connections: Connection[];
  people: Person[];
  cell?: Cell;
}

export const tokenHash = (token: string) => createHash('sha256').update(`nogita-cell:${token}`).digest('hex');

export interface CompanyStore {
  get(id: string): Company | undefined;
  put(company: Company): void;
  delete(id: string): void;
  list(): Company[];
}

export function companiesOf(store: CompanyStore, email: string): Company[] {
  const wanted = email.toLowerCase();
  return store.list().filter(company => company.members.some(member => member.email === wanted));
}
export function companyBySlackTeam(store: CompanyStore, teamId: string): Company | undefined {
  return store.list().find(company => company.connections.some(c => c.kind === 'slack' && c.teamId === teamId));
}
export function companyByCellToken(store: CompanyStore, token: string): Company | undefined {
  const hash = tokenHash(token);
  return store.list().find(company => company.cell?.cellTokenHash === hash);
}

/** A company id from its name: "Acme Engineering" -> "acme-engineering", made unique. */
export function companyId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'company';
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** One JSON file per company, replaced atomically. */
export class FileCompanyStore implements CompanyStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  private file(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('invalid company id');
    return join(this.directory, `${id}.json`);
  }
  get(id: string): Company | undefined {
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')) as Company; } catch { return undefined; }
  }
  put(company: Company): void {
    const file = this.file(company.id);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(company, null, 1)}\n`);
    renameSync(`${file}.tmp`, file);
  }
  delete(id: string): void { rmSync(this.file(id), { force: true }); }
  list(): Company[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.json'))
      .map(name => this.get(name.slice(0, -5))).filter((company): company is Company => company !== undefined);
  }
}

export class MemoryCompanyStore implements CompanyStore {
  private readonly companies = new Map<string, string>();
  get(id: string) { const raw = this.companies.get(id); return raw ? JSON.parse(raw) as Company : undefined; }
  put(company: Company) { this.companies.set(company.id, JSON.stringify(company)); }
  delete(id: string) { this.companies.delete(id); }
  list() { return [...this.companies.keys()].map(id => this.get(id)!); }
}
