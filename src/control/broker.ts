/**
 * The token broker: a cell asks for a fresh token for one of its connections, presenting its own cell token. Tokens
 * that expire (Atlassian, GitHub App installations) are refreshed or minted here, where the app secrets and refresh
 * tokens are; the cell only ever holds an access token that lasts an hour.
 */
import { companyByCellToken, type Company, type CompanyStore } from './store.ts';
import type { Vault } from './vault.ts';
import { refreshAtlassian, type OAuthApps } from './oauth.ts';
import { installationToken } from './github-app.ts';

export interface BrokeredToken { token: string; expiresAt: number }

export class TokenBroker {
  private readonly locks = new Map<string, Promise<BrokeredToken>>();
  private readonly minted = new Map<string, BrokeredToken>();

  constructor(private readonly store: CompanyStore, private readonly vault: Vault, private readonly apps: OAuthApps,
    private readonly http: typeof fetch = fetch, private readonly now = Date.now) {}

  /** The token for a cell's connection, or undefined when the cell token or the connection is not known. */
  async forCell(cellToken: string, connectionId: string): Promise<BrokeredToken | undefined> {
    const company = companyByCellToken(this.store, cellToken);
    if (!company || !company.connections.some(c => c.id === connectionId)) return undefined;
    return this.token(company.id, connectionId);
  }

  /** One refresh at a time per connection: Atlassian rotates refresh tokens, so two at once would lose one. */
  token(companyId: string, connectionId: string): Promise<BrokeredToken> {
    const key = `${companyId}/${connectionId}`;
    const running = this.locks.get(key);
    if (running) return running;
    const work = this.issue(companyId, connectionId).finally(() => this.locks.delete(key));
    this.locks.set(key, work);
    return work;
  }

  private async issue(companyId: string, connectionId: string): Promise<BrokeredToken> {
    // Read again inside the lock: the stored refresh token may have just been rotated.
    const company = this.store.get(companyId);
    const connection = company?.connections.find(c => c.id === connectionId);
    if (!company || !connection) throw new Error('unknown connection');
    switch (connection.kind) {
      case 'slack':
        return { token: this.vault.open(company.id, connection.botToken), expiresAt: this.now() + 3600_000 };
      case 'jira': {
        if (connection.expiresAt - 2 * 60_000 > this.now()) {
          return { token: this.vault.open(company.id, connection.accessToken), expiresAt: connection.expiresAt };
        }
        if (!this.apps.atlassian) throw new Error('Atlassian is not set up on this control plane');
        const fresh = await refreshAtlassian(this.apps.atlassian, this.vault.open(company.id, connection.refreshToken), this.http, this.now());
        Object.assign(connection, { accessToken: this.vault.seal(company.id, fresh.accessToken),
          refreshToken: this.vault.seal(company.id, fresh.refreshToken), expiresAt: fresh.expiresAt });
        this.store.put(company);
        return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
      }
      case 'github': {
        const key = `${company.id}/${connection.id}`;
        const cached = this.minted.get(key);
        if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached;
        if (!this.apps.github) throw new Error('the GitHub App is not set up on this control plane');
        const minted = await installationToken(this.apps.github, connection.installationId,
          connection.repositories.map(r => r.repo), this.http, this.now());
        this.minted.set(key, minted);
        return minted;
      }
    }
  }

  /** Forget minted tokens of a company that is being removed. */
  forget(company: Company): void {
    for (const connection of company.connections) this.minted.delete(`${company.id}/${connection.id}`);
  }
}
