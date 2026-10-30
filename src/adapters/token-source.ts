/**
 * Tokens for provider APIs. Most are fixed strings (an API token, a Slack bot token). OAuth tokens that expire within
 * the hour (Atlassian, GitHub App installations) are minted by the control plane, which alone holds the app secrets
 * and refresh tokens; the cell asks it for a fresh one through the token broker.
 */

/** A token, or where to get a fresh one. */
export type TokenSource = string | (() => Promise<string>);

export const readToken = (source: TokenSource): Promise<string> => typeof source === 'string' ? Promise.resolve(source) : source();

/** In a company config, `"broker:<connection id>"` stands for a token the broker hands out. */
export const BROKER_PREFIX = 'broker:';

/** The cell's side of the token broker: one request per connection until the token is about to expire. */
export class BrokerClient {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly url: string, private readonly cellToken: string,
    private readonly http: typeof fetch = fetch, private readonly now = Date.now) {
    if (!/^https:\/\/|^http:\/\/(?:localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('token broker URL must be HTTPS');
    if (cellToken.length < 32) throw new Error('cell token too short');
  }

  source(connection: string): () => Promise<string> {
    return () => this.token(connection);
  }

  async token(connection: string): Promise<string> {
    const cached = this.cache.get(connection);
    // A minute of margin, so a token never expires halfway through a request.
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const inFlight = this.pending.get(connection);
    if (inFlight) return inFlight;
    const request = this.fetchToken(connection).finally(() => this.pending.delete(connection));
    this.pending.set(connection, request);
    return request;
  }

  private async fetchToken(connection: string): Promise<string> {
    const response = await this.http(new URL('/cell/token', this.url), {
      method: 'POST', headers: { Authorization: `Bearer ${this.cellToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`token broker refused ${connection}: HTTP ${response.status}`);
    const body = await response.json() as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new Error('token broker returned no token');
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : this.now() + 5 * 60_000;
    this.cache.set(connection, { token: body.token, expiresAt });
    return body.token;
  }
}
