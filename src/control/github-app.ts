/**
 * The GitHub App side: a company installs Nogita's app on the repositories it chooses (read-only contents and
 * metadata), and the control plane mints hour-long installation tokens for its cell. The private key never leaves here.
 */
import { createSign } from 'node:crypto';
import type { OAuthApps } from './oauth.ts';

type GitHubApp = NonNullable<OAuthApps['github']>;
const API = 'https://api.github.com';
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nogita-Control' });

/** The app's own JWT (RS256, ten minutes at most), the credential for app-level calls. */
export function appJwt(app: GitHubApp, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // A minute back for clock drift, nine ahead: inside GitHub's ten-minute limit.
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(app.privateKey, 'base64url')}`;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return await response.json() as T;
}

/**
 * The installation in a callback is only a number in the URL; anyone could paste another company's. It is accepted
 * only when the person who just installed it can see it, checked with the user code GitHub sends along.
 */
export async function verifyInstallation(app: GitHubApp, code: string, installationId: number, http: typeof fetch = fetch):
  Promise<{ account: string }> {
  const token = await json<{ access_token?: string; error?: string }>(await http('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }), signal: AbortSignal.timeout(10_000) }),
    'GitHub authorization');
  if (!token.access_token) throw new Error(`GitHub authorization failed: ${token.error ?? 'no token'}`);
  const result = await json<{ installations?: Array<{ id?: number; account?: { login?: string } }> }>(await http(
    `${API}/user/installations?per_page=100`, { headers: headers(token.access_token) }), 'GitHub installations');
  const found = result.installations?.find(item => item.id === installationId);
  if (!found) throw new Error('That GitHub installation is not one you can see');
  return { account: found.account?.login ?? String(installationId) };
}

export interface InstallationToken { token: string; expiresAt: number }

/** A token for the installation, limited to the repositories the company picked when there are some. */
export async function installationToken(app: GitHubApp, installationId: number, repositories: string[] = [],
  http: typeof fetch = fetch, now = Date.now()): Promise<InstallationToken> {
  const result = await json<{ token?: string; expires_at?: string }>(await http(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST', headers: { ...headers(appJwt(app, now)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(repositories.length ? { repositories } : {}), permissions: { contents: 'read', metadata: 'read' } }),
    signal: AbortSignal.timeout(10_000) }), 'GitHub installation token');
  if (!result.token) throw new Error('GitHub returned no installation token');
  return { token: result.token, expiresAt: result.expires_at ? Date.parse(result.expires_at) : now + 3600_000 };
}

/** Repositories the installation can read, for the admin to pick from. */
export async function installationRepositories(token: string, http: typeof fetch = fetch):
  Promise<Array<{ owner: string; repo: string; defaultBranch: string }>> {
  const result = await json<{ repositories?: Array<{ name?: string; owner?: { login?: string }; default_branch?: string }> }>(
    await http(`${API}/installation/repositories?per_page=100`, { headers: headers(token) }), 'GitHub repositories');
  return (result.repositories ?? []).filter(r => r.name && r.owner?.login)
    .map(r => ({ owner: r.owner!.login!, repo: r.name!, defaultBranch: r.default_branch ?? 'main' }));
}

/** Removing a company uninstalls the app from its account. */
export async function deleteInstallation(app: GitHubApp, installationId: number, http: typeof fetch = fetch): Promise<void> {
  const response = await http(`${API}/app/installations/${installationId}`, { method: 'DELETE', headers: headers(appJwt(app)) });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub uninstall failed: HTTP ${response.status}`);
}
