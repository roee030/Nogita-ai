/**
 * What an admin does to set up their company, as plain operations (the web pages call these): connect tools, give the
 * company's own vendor keys, pick projects and repositories, approve people, start or update the cell, delete it all.
 */
import { companyId, tokenHash, type Company, type CompanyKeys, type CompanyStore, type Person } from './store.ts';
import type { Vault } from './vault.ts';
import type { AtlassianSite, AtlassianTokens, OAuthApps, SlackInstall } from './oauth.ts';
import { deleteInstallation } from './github-app.ts';
import type { Provisioner } from './provisioner.ts';
import { cellEnvironment, environmentHash, newCellSecrets } from './cell.ts';
import type { TokenBroker } from './broker.ts';

export interface CompanyServiceOptions {
  store: CompanyStore; vault: Vault; apps: OAuthApps; provisioner: Provisioner; broker: TokenBroker;
  /** The control plane's public URL: cells call its token broker. */
  publicUrl: string;
  http?: typeof fetch;
  now?: () => Date;
}

export class CompanyService {
  private readonly http: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly o: CompanyServiceOptions) {
    this.http = o.http ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  get(id: string): Company | undefined { return this.o.store.get(id); }

  create(name: string, admin: { email: string; name: string }): Company {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Give the company a name');
    const company: Company = { id: companyId(clean, id => Boolean(this.o.store.get(id))), name: clean,
      createdAt: this.now().toISOString(), members: [{ email: admin.email.toLowerCase(), name: admin.name, role: 'admin' }],
      keys: {}, meetingPrivacyReviewed: false, connections: [],
      // The person who sets Nogita up may ask her for changes from the start.
      people: [{ id: personId(admin.email, new Set()), displayName: admin.name, email: admin.email.toLowerCase(), authorized: true }] };
    this.o.store.put(company);
    return company;
  }

  addMember(company: Company, email: string, role: 'admin' | 'member'): void {
    const wanted = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wanted)) throw new Error('That is not an email address');
    const existing = company.members.find(m => m.email === wanted);
    if (existing) existing.role = role; else company.members.push({ email: wanted, role });
    this.o.store.put(company);
  }

  /** The company's own vendor keys. An empty field keeps the key already saved. */
  saveKeys(company: Company, keys: Partial<Record<keyof CompanyKeys, string>>, meetingPrivacyReviewed: boolean): void {
    for (const [name, value] of Object.entries(keys) as Array<[keyof CompanyKeys, string | undefined]>) {
      if (value?.trim()) company.keys[name] = this.o.vault.seal(company.id, value.trim());
    }
    company.meetingPrivacyReviewed = meetingPrivacyReviewed;
    this.o.store.put(company);
  }

  connectSlack(company: Company, install: SlackInstall, by: string): void {
    const other = this.o.store.list().find(c => c.id !== company.id &&
      c.connections.some(x => x.kind === 'slack' && x.teamId === install.teamId));
    // One Slack workspace, one company: its events are routed by workspace.
    if (other) throw new Error('That Slack workspace is already connected to another company');
    company.connections = company.connections.filter(c => c.kind !== 'slack');
    company.connections.push({ id: 'slack', kind: 'slack', teamId: install.teamId, teamName: install.teamName,
      botUserId: install.botUserId, botToken: this.o.vault.seal(company.id, install.botToken), connectedBy: by });
    this.o.store.put(company);
  }

  /** Each Jira site the person allowed becomes a connection; tasks go nowhere until a project is picked. */
  connectAtlassian(company: Company, tokens: AtlassianTokens, sites: AtlassianSite[], by: string): void {
    if (!sites.length) throw new Error('No Jira site was allowed. Try again and pick your site.');
    for (const site of sites) {
      const existing = company.connections.find(c => c.kind === 'jira' && c.cloudId === site.cloudId);
      const sealed = { accessToken: this.o.vault.seal(company.id, tokens.accessToken),
        refreshToken: this.o.vault.seal(company.id, tokens.refreshToken), expiresAt: tokens.expiresAt };
      if (existing?.kind === 'jira') { Object.assign(existing, sealed, { connectedBy: by }); continue; }
      company.connections.push({ id: uniqueId(company, `jira-${site.name}`), kind: 'jira', cloudId: site.cloudId,
        siteUrl: site.url, siteName: site.name, ...sealed, connectedBy: by });
    }
    this.o.store.put(company);
  }

  chooseJiraProject(company: Company, connectionId: string, projectKey: string, readProjectKeys: string[]): void {
    const connection = company.connections.find(c => c.id === connectionId);
    if (connection?.kind !== 'jira') throw new Error('No such Jira connection');
    if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(projectKey)) throw new Error('Pick a Jira project');
    connection.projectKey = projectKey;
    connection.readProjectKeys = readProjectKeys.filter(key => /^[A-Za-z][A-Za-z0-9_]+$/.test(key) && key !== projectKey);
    this.o.store.put(company);
  }

  connectGitHub(company: Company, installationId: number, account: string, by: string): void {
    const other = this.o.store.list().find(c => c.id !== company.id &&
      c.connections.some(x => x.kind === 'github' && x.installationId === installationId));
    if (other) throw new Error('That GitHub installation is already connected to another company');
    if (company.connections.some(c => c.kind === 'github' && c.installationId === installationId)) return;
    company.connections.push({ id: uniqueId(company, `github-${account}`), kind: 'github', installationId, account,
      repositories: [], connectedBy: by });
    this.o.store.put(company);
  }

  chooseRepositories(company: Company, connectionId: string, repositories: Array<{ owner: string; repo: string; ref: string }>): void {
    const connection = company.connections.find(c => c.id === connectionId);
    if (connection?.kind !== 'github') throw new Error('No such GitHub connection');
    connection.repositories = repositories.slice(0, 20);
    this.o.store.put(company);
  }

  disconnect(company: Company, connectionId: string): void {
    company.connections = company.connections.filter(c => c.id !== connectionId);
    this.o.store.put(company);
  }

  /**
   * People from the Slack workspace, matched to the ones already known by email. Nobody new may ask for changes until
   * the admin approves them; approvals already given are kept.
   */
  async syncPeople(company: Company): Promise<{ added: number; updated: number }> {
    const slack = company.connections.find(c => c.kind === 'slack');
    if (slack?.kind !== 'slack') throw new Error('Connect Slack first');
    const token = this.o.vault.open(company.id, slack.botToken);
    let added = 0; let updated = 0; let cursor = '';
    const ids = new Set(company.people.map(p => p.id));
    for (let page = 0; page < 20; page++) {
      const url = new URL('https://slack.com/api/users.list');
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await this.http(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as { ok?: boolean; error?: string; response_metadata?: { next_cursor?: string };
        members?: Array<{ id?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string; real_name?: string; display_name?: string } }> };
      if (!result.ok) throw new Error(`Slack users.list failed: ${result.error ?? 'unknown'}`);
      for (const member of result.members ?? []) {
        const email = member.profile?.email?.toLowerCase();
        if (!member.id || member.deleted || member.is_bot || !email) continue;
        const displayName = member.profile?.real_name || member.profile?.display_name || email;
        const known = company.people.find(p => p.email === email);
        if (known) {
          known.slack = { teamId: slack.teamId, userId: member.id };
          updated++;
        } else {
          const person: Person = { id: personId(email, ids), displayName, email, slack: { teamId: slack.teamId, userId: member.id },
            authorized: false };
          ids.add(person.id);
          company.people.push(person);
          added++;
        }
      }
      cursor = result.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    this.o.store.put(company);
    return { added, updated };
  }

  setAuthorized(company: Company, authorizedIds: Set<string>): void {
    for (const person of company.people) person.authorized = authorizedIds.has(person.id);
    this.o.store.put(company);
  }

  /**
   * Starts the company's cell, or sends it what changed. A new cell gets its address only once it exists, so it is
   * created and then updated once with the address (for its meeting webhooks).
   */
  async deployCell(company: Company): Promise<'created' | 'updated' | 'unchanged'> {
    const brokerUrl = this.o.publicUrl;
    if (!company.cell) {
      const { secrets, cellToken } = newCellSecrets(this.o.vault, company.id);
      const env = cellEnvironment(company, { secrets }, this.o.vault, { brokerUrl });
      const created = await this.o.provisioner.create({ companyId: company.id, env });
      company.cell = { provider: 'render', serviceId: created.serviceId, url: created.url, status: 'provisioning',
        cellTokenHash: tokenHash(cellToken), secrets, updatedAt: this.now().toISOString() };
      this.o.store.put(company);
      const full = cellEnvironment(company, company.cell, this.o.vault, { brokerUrl, cellUrl: created.url });
      await this.o.provisioner.update(created.serviceId, full);
      company.cell.configHash = environmentHash(full);
      this.o.store.put(company);
      return 'created';
    }
    const env = cellEnvironment(company, company.cell, this.o.vault, { brokerUrl, cellUrl: company.cell.url });
    const hash = environmentHash(env);
    if (hash === company.cell.configHash) return 'unchanged';
    await this.o.provisioner.update(company.cell.serviceId, env);
    Object.assign(company.cell, { configHash: hash, status: 'provisioning', updatedAt: this.now().toISOString() });
    this.o.store.put(company);
    return 'updated';
  }

  async refreshCellStatus(company: Company): Promise<void> {
    if (!company.cell) return;
    const status = await this.o.provisioner.status(company.cell.serviceId);
    const next = status === 'live' ? 'live' : status === 'failed' ? 'failed' : company.cell.status;
    if (next !== company.cell.status) { company.cell.status = next; this.o.store.put(company); }
  }

  /** Everything goes: the cell and its disk, the Slack token, the GitHub installation, and the record. */
  async delete(company: Company): Promise<string[]> {
    const problems: string[] = [];
    if (company.cell) {
      try { await this.o.provisioner.destroy(company.cell.serviceId); }
      catch (error) { problems.push(`cell: ${error instanceof Error ? error.message : 'failed'}`); }
    }
    for (const connection of company.connections) {
      try {
        if (connection.kind === 'slack') {
          await this.http('https://slack.com/api/auth.revoke', { method: 'POST',
            headers: { Authorization: `Bearer ${this.o.vault.open(company.id, connection.botToken)}` } });
        } else if (connection.kind === 'github' && this.o.apps.github) {
          await deleteInstallation(this.o.apps.github, connection.installationId, this.http);
        }
        // Atlassian has no revoke call; the grant is removed with the record and the person can remove the app in Atlassian.
      } catch (error) { problems.push(`${connection.id}: ${error instanceof Error ? error.message : 'failed'}`); }
    }
    this.o.broker.forget(company);
    // The record goes even when a provider could not be reached: its secrets must not outlive the company.
    this.o.store.delete(company.id);
    return problems;
  }
}

function personId(email: string, taken: Set<string>): string {
  const base = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'person';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function uniqueId(company: Company, wanted: string): string {
  const base = wanted.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'connection';
  let id = base;
  for (let n = 2; company.connections.some(c => c.id === id); n++) id = `${base}-${n}`;
  return id;
}
