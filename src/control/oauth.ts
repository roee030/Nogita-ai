/**
 * One click per tool: the control plane is registered once as an app with each provider, and a company installs it.
 * This file is the OAuth half: the authorize URLs, the signed `state` that ties a callback to the browser and company
 * that started it, and the code exchanges. Every network call goes through an injected fetch, so tests use fakes.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Provider = 'google' | 'microsoft' | 'slack' | 'atlassian' | 'github';

export interface OAuthApp { clientId: string; clientSecret: string }
export interface OAuthApps {
  google?: OAuthApp; microsoft?: OAuthApp; slack?: OAuthApp; atlassian?: OAuthApp;
  /** A GitHub App: its slug (for the install page), id and private key (to mint installation tokens), and OAuth client. */
  github?: OAuthApp & { slug: string; appId: string; privateKey: string };
}

/** What Nogita asks Slack for: read channels it is in, post, read people (with email, to match them), hear mentions. */
export const SLACK_BOT_SCOPES = ['app_mentions:read', 'channels:read', 'groups:read', 'channels:history', 'groups:history',
  'im:history', 'users:read', 'users:read.email', 'chat:write'];
export const ATLASSIAN_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];

// ---- state ----

export interface OAuthState { provider: Provider; nonce: string; company?: string; expiresAt: number }

/** `state` is signed so a callback cannot be forged, and carries a nonce that must match the browser's cookie. */
export class StateSigner {
  constructor(private readonly secret: string, private readonly now = Date.now) {
    if (secret.length < 32) throw new Error('CONTROL_SESSION_SECRET must be at least 32 characters');
  }
  private sign(body: string): string { return createHmac('sha256', this.secret).update(`state:${body}`).digest('base64url'); }
  issue(provider: Provider, company?: string): { state: string; nonce: string } {
    const nonce = randomBytes(16).toString('base64url');
    const body = Buffer.from(JSON.stringify({ provider, nonce, company, expiresAt: this.now() + 10 * 60_000 })).toString('base64url');
    return { state: `${body}.${this.sign(body)}`, nonce };
  }
  verify(state: string | null, nonce: string | undefined, provider: Provider): OAuthState | undefined {
    if (!state || !nonce) return undefined;
    const [body, signature] = state.split('.');
    if (!body || !signature) return undefined;
    if (!same(this.sign(body), signature)) return undefined;
    let parsed: OAuthState;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState; } catch { return undefined; }
    if (parsed.provider !== provider || parsed.expiresAt < this.now()) return undefined;
    return same(parsed.nonce, nonce) ? parsed : undefined;
  }
}

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- authorize URLs ----

export function authorizeUrl(provider: Provider, apps: OAuthApps, redirectUri: string, state: string): string {
  const app = apps[provider];
  if (!app) throw new Error(`${provider} is not set up on this control plane`);
  const url = (base: string, params: Record<string, string>) => {
    const u = new URL(base);
    for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
    return u.href;
  };
  switch (provider) {
    case 'google': return url('https://accounts.google.com/o/oauth2/v2/auth', { client_id: app.clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    case 'microsoft': return url('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', { client_id: app.clientId,
      redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile User.Read', state, prompt: 'select_account' });
    case 'slack': return url('https://slack.com/oauth/v2/authorize', { client_id: app.clientId, redirect_uri: redirectUri,
      scope: SLACK_BOT_SCOPES.join(','), state });
    case 'atlassian': return url('https://auth.atlassian.com/authorize', { audience: 'api.atlassian.com', client_id: app.clientId,
      scope: ATLASSIAN_SCOPES.join(' '), redirect_uri: redirectUri, state, response_type: 'code', prompt: 'consent' });
    // The app is set to ask for user authorization during installation, so the callback also brings a code that
    // proves which installations the person who installed it can see.
    case 'github': return url(`https://github.com/apps/${apps.github!.slug}/installations/new`, { state });
  }
}

// ---- exchanges ----

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return await response.json() as T;
}
const form = (params: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(params),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });

export interface SignedInUser { email: string; name: string }

/** Google or Microsoft sign-in: the person's verified work email. */
export async function signIn(provider: 'google' | 'microsoft', app: OAuthApp, code: string, redirectUri: string,
  http: typeof fetch = fetch): Promise<SignedInUser> {
  if (provider === 'google') {
    const token = await json<{ access_token?: string }>(await http('https://oauth2.googleapis.com/token', form({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret })),
      'Google sign-in');
    const info = await json<{ email?: string; email_verified?: boolean; name?: string }>(await http(
      'https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } }), 'Google profile');
    if (!info.email || info.email_verified !== true) throw new Error('Google did not confirm this email');
    return { email: info.email.toLowerCase(), name: info.name ?? info.email };
  }
  const token = await json<{ access_token?: string }>(await http('https://login.microsoftonline.com/common/oauth2/v2.0/token', form({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret,
    scope: 'openid email profile User.Read' })), 'Microsoft sign-in');
  const me = await json<{ mail?: string | null; displayName?: string }>(await http(
    'https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${token.access_token}` } }), 'Microsoft profile');
  // A work account's mail is set by its organization; a personal account has none and is not accepted.
  if (!me.mail) throw new Error('Sign in with a work Microsoft account');
  return { email: me.mail.toLowerCase(), name: me.displayName ?? me.mail };
}

export interface SlackInstall { teamId: string; teamName: string; botUserId: string; botToken: string }

export async function installSlack(app: OAuthApp, code: string, redirectUri: string, http: typeof fetch = fetch): Promise<SlackInstall> {
  const result = await json<{ ok?: boolean; error?: string; access_token?: string; bot_user_id?: string;
    team?: { id?: string; name?: string } }>(await http('https://slack.com/api/oauth.v2.access', form({
    code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret })), 'Slack install');
  if (!result.ok || !result.access_token?.startsWith('xoxb-') || !result.team?.id || !result.bot_user_id) {
    throw new Error(`Slack install failed: ${result.error ?? 'incomplete answer'}`);
  }
  return { teamId: result.team.id, teamName: result.team.name ?? result.team.id, botUserId: result.bot_user_id, botToken: result.access_token };
}

export interface AtlassianTokens { accessToken: string; refreshToken: string; expiresAt: number }
export interface AtlassianSite { cloudId: string; url: string; name: string }

async function atlassianToken(app: OAuthApp, grant: Record<string, string>, http: typeof fetch, now: number): Promise<AtlassianTokens> {
  const result = await json<{ access_token?: string; refresh_token?: string; expires_in?: number }>(await http(
    'https://auth.atlassian.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...grant, client_id: app.clientId, client_secret: app.clientSecret }), signal: AbortSignal.timeout(10_000) }),
    'Atlassian token');
  if (!result.access_token || !result.refresh_token) throw new Error('Atlassian returned no tokens (is offline_access granted?)');
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: now + (result.expires_in ?? 3600) * 1000 };
}

/** Jira: the tokens, and the Jira sites the person allowed (each becomes its own connection). */
export async function installAtlassian(app: OAuthApp, code: string, redirectUri: string, http: typeof fetch = fetch,
  now = Date.now()): Promise<{ tokens: AtlassianTokens; sites: AtlassianSite[] }> {
  const tokens = await atlassianToken(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, http, now);
  const resources = await json<Array<{ id?: string; url?: string; name?: string; scopes?: string[] }>>(await http(
    'https://api.atlassian.com/oauth/token/accessible-resources', { headers: { Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json' } }), 'Atlassian sites');
  const sites = (Array.isArray(resources) ? resources : [])
    .filter(site => site.id && site.url && site.scopes?.includes('read:jira-work'))
    .map(site => ({ cloudId: site.id!, url: site.url!, name: site.name ?? site.url! }));
  return { tokens, sites };
}

/** Atlassian rotates refresh tokens: the new one must be stored before the old one is used again. */
export function refreshAtlassian(app: OAuthApp, refreshToken: string, http: typeof fetch = fetch, now = Date.now()): Promise<AtlassianTokens> {
  return atlassianToken(app, { grant_type: 'refresh_token', refresh_token: refreshToken }, http, now);
}

/** Jira projects on a site, for the admin to pick where tasks go. */
export async function jiraProjects(cloudId: string, accessToken: string, http: typeof fetch = fetch):
  Promise<Array<{ key: string; name: string }>> {
  const result = await json<{ values?: Array<{ key?: string; name?: string }> }>(await http(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/project/search?maxResults=100`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }), 'Jira projects');
  return (result.values ?? []).filter(p => p.key).map(p => ({ key: p.key!, name: p.name ?? p.key! }));
}
