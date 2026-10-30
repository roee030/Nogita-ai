/**
 * The control plane's web app: sign-in, the setup pages, the OAuth callbacks, the shared Slack events URL, and the
 * token broker for cells. `controlApp` is the request handler (tests drive it directly); `main.ts` starts it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { companiesOf, type Company, type CompanyStore } from './store.ts';
import type { Vault } from './vault.ts';
import { authorizeUrl, installAtlassian, installSlack, jiraProjects, same, signIn, StateSigner, type OAuthApps,
  type Provider } from './oauth.ts';
import { installationRepositories, installationToken, verifyInstallation } from './github-app.ts';
import { CompanyService } from './companies.ts';
import type { TokenBroker } from './broker.ts';
import { routeSlackEvent } from './slack-router.ts';
import { createCompanyPage, dashboardPage, layout, signInPage, type DashboardExtras } from './pages.ts';

export interface ControlDeps {
  store: CompanyStore; vault: Vault; apps: OAuthApps; companies: CompanyService; broker: TokenBroker;
  publicUrl: string; sessionSecret: string; slackSigningSecret?: string;
  http?: typeof fetch; now?: () => number;
}

interface Session { email: string; name: string; expiresAt: number }
const SESSION = 'nogita_session';
const NONCE = 'nogita_oauth';
const MAX_BODY = 256 * 1024;

export function controlApp(deps: ControlDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? Date.now;
  const http = deps.http ?? fetch;
  const states = new StateSigner(deps.sessionSecret, now);
  const secure = deps.publicUrl.startsWith('https:');
  const redirectUri = (provider: Provider) => `${deps.publicUrl}/oauth/${provider}/callback`;
  const mac = (purpose: string, value: string) => createHmac('sha256', deps.sessionSecret).update(`${purpose}:${value}`).digest('base64url');

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const cookies = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie ?? '').split(';')
    .map(part => part.trim().split('=')).filter(([key, value]) => key && value).map(([key, value]) => [key!, value!]));

  function session(req: IncomingMessage): (Session & { raw: string }) | undefined {
    const raw = cookies(req)[SESSION];
    const [body, signature] = raw?.split('.') ?? [];
    if (!body || !signature || !same(mac('session', body), signature)) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
      return parsed.expiresAt > now() ? { ...parsed, raw: body } : undefined;
    } catch { return undefined; }
  }
  const csrfFor = (s: { raw: string }) => mac('csrf', s.raw);

  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...headers });
    res.end(body);
  };
  const redirect = (res: ServerResponse, location: string, setCookie?: string | string[]) =>
    send(res, 303, '', { Location: location, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error('body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** A company page needs a signed-in member; changing it needs an admin and the form's CSRF token. */
  function membership(s: Session): { company: Company; admin: boolean } | undefined {
    const company = companiesOf(deps.store, s.email)[0];
    if (!company) return undefined;
    return { company, admin: company.members.some(m => m.email === s.email && m.role === 'admin') };
  }

  async function extras(company: Company, isAdmin: boolean): Promise<DashboardExtras> {
    const result: DashboardExtras = { jiraProjects: {}, githubRepositories: {}, isAdmin,
      apps: { slack: Boolean(deps.apps.slack), atlassian: Boolean(deps.apps.atlassian), github: Boolean(deps.apps.github) } };
    if (!isAdmin) return result;
    await Promise.all(company.connections.map(async connection => {
      try {
        if (connection.kind === 'jira') {
          const { token } = await deps.broker.token(company.id, connection.id);
          result.jiraProjects[connection.id] = await jiraProjects(connection.cloudId, token, http);
        } else if (connection.kind === 'github' && deps.apps.github) {
          const { token } = await installationToken(deps.apps.github, connection.installationId, [], http);
          result.githubRepositories[connection.id] = await installationRepositories(token, http);
        }
      } catch {
        if (connection.kind === 'jira') result.jiraProjects[connection.id] = 'Could not load projects. Try connecting again.';
        if (connection.kind === 'github') result.githubRepositories[connection.id] = 'Could not load repositories. Try installing again.';
      }
    }));
    return result;
  }

  async function oauthCallback(provider: Provider, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = states.verify(url.searchParams.get('state'), cookies(req)[NONCE], provider);
    const clear = cookie(NONCE, 'x', 0);
    if (!state) { send(res, 400, layout('Nogita', '<p>That link expired or did not start here. <a href="/">Start again</a>.</p>'), { 'Set-Cookie': clear }); return; }
    const code = url.searchParams.get('code') ?? '';
    if (provider === 'google' || provider === 'microsoft') {
      const user = await signIn(provider, deps.apps[provider]!, code, redirectUri(provider), http);
      const body = Buffer.from(JSON.stringify({ email: user.email, name: user.name, expiresAt: now() + 12 * 3600_000 })).toString('base64url');
      redirect(res, '/app', [clear, cookie(SESSION, `${body}.${mac('session', body)}`, 12 * 3600)]);
      return;
    }
    const s = session(req);
    const member = s && membership(s);
    if (!s || !member?.admin || member.company.id !== state.company) { redirect(res, '/', clear); return; }
    const { company } = member;
    if (provider === 'slack') {
      deps.companies.connectSlack(company, await installSlack(deps.apps.slack!, code, redirectUri('slack'), http), s.email);
    } else if (provider === 'atlassian') {
      const { tokens, sites } = await installAtlassian(deps.apps.atlassian!, code, redirectUri('atlassian'), http, now());
      deps.companies.connectAtlassian(company, tokens, sites, s.email);
    } else if (provider === 'github') {
      const installationId = Number(url.searchParams.get('installation_id'));
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('GitHub sent no installation');
      const { account } = await verifyInstallation(deps.apps.github!, code, installationId, http);
      deps.companies.connectGitHub(company, installationId, account, s.email);
    }
    redirect(res, `/app?done=${provider}`, clear);
  }

  async function postForm(pathname: string, form: URLSearchParams, s: Session & { raw: string }, res: ServerResponse): Promise<void> {
    if (!same(form.get('csrf') ?? '', csrfFor(s))) { send(res, 403, layout('Nogita', '<p>That form expired. <a href="/app">Reload</a>.</p>')); return; }
    if (pathname === '/app/company') {
      if (companiesOf(deps.store, s.email).length) { redirect(res, '/app'); return; }
      deps.companies.create(form.get('name') ?? '', s);
      redirect(res, '/app'); return;
    }
    const member = membership(s);
    if (!member?.admin) { send(res, 403, layout('Nogita', '<p>Only an admin can change this.</p>')); return; }
    const { company } = member;
    let notice = '';
    switch (pathname) {
      case '/app/keys':
        deps.companies.saveKeys(company, { anthropic: form.get('anthropic') ?? '', deepgram: form.get('deepgram') ?? '',
          attendee: form.get('attendee') ?? '', attendeeWebhookSecret: form.get('attendeeWebhookSecret') ?? '' }, form.get('privacy') === 'on');
        notice = 'Saved.'; break;
      case '/app/jira':
        deps.companies.chooseJiraProject(company, form.get('connection') ?? '', form.get('project') ?? '', form.getAll('read'));
        notice = 'Saved.'; break;
      case '/app/repos':
        deps.companies.chooseRepositories(company, form.get('connection') ?? '', form.getAll('repo').flatMap(value => {
          const match = value.match(/^([\w.-]+)\/([\w.-]+)@([\w./-]+)$/);
          return match ? [{ owner: match[1]!, repo: match[2]!, ref: match[3]! }] : [];
        }));
        notice = 'Saved.'; break;
      case '/app/disconnect':
        deps.companies.disconnect(company, form.get('connection') ?? '');
        notice = 'Disconnected. Update Nogita to apply it.'; break;
      case '/app/people/sync': {
        const { added, updated } = await deps.companies.syncPeople(company);
        notice = `${added} people added, ${updated} matched. Tick who may ask for changes.`; break;
      }
      case '/app/people':
        deps.companies.setAuthorized(company, new Set(form.getAll('authorized')));
        notice = 'Saved.'; break;
      case '/app/members':
        deps.companies.addMember(company, form.get('email') ?? '', form.get('admin') === 'on' ? 'admin' : 'member');
        notice = 'Added. They can sign in now.'; break;
      case '/app/cell': {
        const result = await deps.companies.deployCell(company);
        notice = result === 'created' ? 'Nogita is starting. It takes a few minutes.' : result === 'updated' ? 'Sent. She restarts with the changes.' : 'Nothing changed.';
        break;
      }
      case '/app/delete': {
        const problems = await deps.companies.delete(company);
        redirect(res, `/?notice=${encodeURIComponent(problems.length ? `Deleted. Some providers could not be reached: ${problems.join('; ')}` : 'Deleted.')}`,
          cookie(SESSION, 'x', 0));
        return;
      }
      default: send(res, 404, layout('Nogita', '<p>Not found.</p>')); return;
    }
    redirect(res, `/app?notice=${encodeURIComponent(notice)}`);
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', deps.publicUrl);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/health') { json(res, 200, { ok: true }); return; }

      if (req.method === 'POST' && pathname === '/slack/events') {
        if (!deps.slackSigningSecret) { json(res, 404, { error: 'Slack is not set up' }); return; }
        const routed = await routeSlackEvent({ body: await readBody(req),
          timestamp: req.headers['x-slack-request-timestamp'] as string ?? null, signature: req.headers['x-slack-signature'] as string ?? null,
          retryNum: req.headers['x-slack-retry-num'] as string ?? null, retryReason: req.headers['x-slack-retry-reason'] as string ?? null },
        { signingSecret: deps.slackSigningSecret, store: deps.store, vault: deps.vault, http, nowSec: () => Math.floor(now() / 1000) });
        send(res, routed.status, routed.body, { 'Content-Type': routed.contentType ?? 'text/plain' }); return;
      }

      if (req.method === 'POST' && pathname === '/cell/token') {
        const bearer = (req.headers.authorization ?? '').match(/^Bearer (\S+)$/)?.[1];
        let connection = '';
        try { connection = String((JSON.parse(await readBody(req)) as { connection?: unknown }).connection ?? ''); } catch { /* empty */ }
        const token = bearer && connection ? await deps.broker.forCell(bearer, connection) : undefined;
        if (!token) { json(res, 403, { error: 'unknown cell or connection' }); return; }
        json(res, 200, token); return;
      }

      const login = pathname.match(/^\/login\/(google|microsoft)$/);
      if (req.method === 'GET' && login) {
        const provider = login[1] as 'google' | 'microsoft';
        if (!deps.apps[provider]) { redirect(res, '/'); return; }
        const { state, nonce } = states.issue(provider);
        redirect(res, authorizeUrl(provider, deps.apps, redirectUri(provider), state), cookie(NONCE, nonce, 600)); return;
      }
      const callback = pathname.match(/^\/oauth\/(google|microsoft|slack|atlassian|github)\/callback$/);
      if (req.method === 'GET' && callback) {
        const provider = callback[1] as Provider;
        if (!deps.apps[provider]) { redirect(res, '/'); return; }
        if (url.searchParams.get('error')) { redirect(res, `/app?notice=${encodeURIComponent('Cancelled.')}`); return; }
        await oauthCallback(provider, url, req, res); return;
      }

      if (req.method === 'GET' && pathname === '/logout') { redirect(res, '/', cookie(SESSION, 'x', 0)); return; }
      const s = session(req);
      if (req.method === 'GET' && pathname === '/') {
        if (s) { redirect(res, '/app'); return; }
        send(res, 200, signInPage({ google: Boolean(deps.apps.google), microsoft: Boolean(deps.apps.microsoft) },
          url.searchParams.get('notice') ?? undefined)); return;
      }
      if (!s) { redirect(res, '/'); return; }

      const connect = pathname.match(/^\/connect\/(slack|atlassian|github)$/);
      if (req.method === 'GET' && connect) {
        const provider = connect[1] as Provider;
        const member = membership(s);
        if (!member?.admin || !deps.apps[provider]) { redirect(res, '/app'); return; }
        const { state, nonce } = states.issue(provider, member.company.id);
        redirect(res, authorizeUrl(provider, deps.apps, redirectUri(provider), state), cookie(NONCE, nonce, 600)); return;
      }
      if (req.method === 'GET' && pathname === '/app') {
        const member = membership(s);
        const notice = url.searchParams.get('notice') ?? undefined;
        if (!member) { send(res, 200, createCompanyPage(csrfFor(s), s.email, notice)); return; }
        await deps.companies.refreshCellStatus(member.company).catch(() => undefined);
        send(res, 200, dashboardPage(member.company, csrfFor(s), await extras(member.company, member.admin), notice)); return;
      }
      if (req.method === 'POST' && pathname.startsWith('/app/')) {
        await postForm(pathname, new URLSearchParams(await readBody(req)), s, res); return;
      }
      send(res, 404, layout('Nogita', '<p>Not found.</p>'));
    } catch (error) {
      // The message names what went wrong for the admin; it never carries a token (providers' errors are summarized).
      const message = error instanceof Error ? error.message : 'Something went wrong';
      console.error('control_request_failed', pathname, message);
      if (pathname.startsWith('/app') || pathname.startsWith('/oauth/')) redirect(res, `/app?notice=${encodeURIComponent(message)}`);
      else json(res, 500, { error: 'failed' });
    }
  };
}
