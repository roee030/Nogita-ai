import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Vault } from '../src/control/vault.ts';
import { MemoryCompanyStore, type Company } from '../src/control/store.ts';
import { StateSigner, type OAuthApps } from '../src/control/oauth.ts';
import { appJwt } from '../src/control/github-app.ts';
import { TokenBroker } from '../src/control/broker.ts';
import { CompanyService } from '../src/control/companies.ts';
import { MemoryProvisioner, RenderProvisioner } from '../src/control/provisioner.ts';
import { controlApp } from '../src/control/server.ts';
import { signForCell } from '../src/control/slack-router.ts';
import { verifySlackSignature } from '../src/adapters/slack.ts';
import { BrokerClient } from '../src/adapters/token-source.ts';
import { parseTenantConfig } from '../src/app/tenant-config.ts';
import { buildDependencies } from '../src/app/config.ts';
import { JiraBoard } from '../src/adapters/jira.ts';

const vaultKey = Buffer.alloc(32, 3).toString('base64');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const apps: OAuthApps = {
  google: { clientId: 'g-id', clientSecret: 'g-secret' },
  slack: { clientId: 's-id', clientSecret: 's-secret' },
  atlassian: { clientId: 'a-id', clientSecret: 'a-secret' },
  github: { clientId: 'gh-id', clientSecret: 'gh-secret', slug: 'nogita', appId: '42', privateKey },
};
const SLACK_APP_SECRET = 'slack-app-signing-secret';
const CLOUD = '11111111-2222-3333-4444-555555555555';

test('vault: a company secret opens only for that company', () => {
  const vault = new Vault(vaultKey);
  const sealed = vault.seal('acme', 'xoxb-secret');
  assert.doesNotMatch(sealed, /xoxb/);
  assert.equal(vault.open('acme', sealed), 'xoxb-secret');
  assert.throws(() => vault.open('globex', sealed));
  assert.throws(() => new Vault('short'), /32 random bytes/);
});

test('oauth state: signed, bound to the browser nonce and the provider, and short-lived', () => {
  let now = 1_000;
  const signer = new StateSigner('x'.repeat(40), () => now);
  const { state, nonce } = signer.issue('slack', 'acme');
  assert.equal(signer.verify(state, nonce, 'slack')?.company, 'acme');
  assert.equal(signer.verify(state, 'other-nonce', 'slack'), undefined);
  assert.equal(signer.verify(state, nonce, 'atlassian'), undefined);
  const [body] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), company: 'globex' })).toString('base64url');
  assert.equal(signer.verify(`${forged}.${state.split('.')[1]}`, nonce, 'slack'), undefined);
  now += 11 * 60_000;
  assert.equal(signer.verify(state, nonce, 'slack'), undefined);
});

test('github app: the JWT is RS256, signed with the app key, and inside the ten-minute limit', () => {
  const jwt = appJwt(apps.github!, 1_700_000_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature!, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  assert.equal(claims.iss, '42');
  assert.ok(claims.exp - claims.iat <= 600);
});

test('render: a cell is a Node service with its own disk; updates replace the environment and deploy', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const http = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === 'POST' && String(url).endsWith('/services')) {
      return Response.json({ service: { id: 'srv-1', serviceDetails: { url: 'https://nogita-acme.onrender.com' } }, deployId: 'dep-1' }, { status: 201 });
    }
    if (String(url).includes('/deploys?limit=1')) return Response.json([{ deploy: { status: 'build_in_progress' } }]);
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({});
  }) as typeof fetch;
  const render = new RenderProvisioner({ apiKey: 'rnd', ownerId: 'tea-1', repo: 'https://github.com/roee030/Nogita-ai', branch: 'main' }, http);
  assert.deepEqual(await render.create({ companyId: 'acme', env: { A: '1' } }), { serviceId: 'srv-1', url: 'https://nogita-acme.onrender.com' });
  const created = calls[0]!.body as { name: string; serviceDetails: { disk: { mountPath: string }; envSpecificDetails: { startCommand: string } };
    envVars: unknown };
  assert.equal(created.name, 'nogita-acme');
  assert.equal(created.serviceDetails.disk.mountPath, '/var/data');
  assert.equal(created.serviceDetails.envSpecificDetails.startCommand, 'npm start');
  assert.deepEqual(created.envVars, [{ key: 'A', value: '1' }]);
  await render.update('srv-1', { A: '2' });
  assert.deepEqual(calls.slice(1).map(call => `${call.method} ${new URL(call.url).pathname}`),
    ['PUT /v1/services/srv-1/env-vars', 'POST /v1/services/srv-1/deploys']);
  assert.equal(await render.status('srv-1'), 'building');
  await render.destroy('srv-1');
  assert.equal(calls.at(-1)!.method, 'DELETE');
});

/** Every provider the control plane and the cell talk to, answering from a little shared state. */
function providers() {
  const state = { atlassianRefresh: 'refresh-1', atlassianAccess: 'access-1', refreshes: 0, cellEvents: [] as Array<{ body: string; ok: boolean }>,
    cellSecret: '', revoked: [] as string[], uninstalled: [] as string[], jiraAuth: [] as string[] };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(String(init.body)) : {};
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    switch (route) {
      case 'POST oauth2.googleapis.com/token': return Response.json({ access_token: 'g-access' });
      case 'GET openidconnect.googleapis.com/v1/userinfo': return Response.json({ email: 'Dana@Acme.example', email_verified: true, name: 'Dana Katz' });
      case 'POST slack.com/api/oauth.v2.access':
        return Response.json(body.code === 'slack-code'
          ? { ok: true, access_token: 'xoxb-acme', bot_user_id: 'UBOT', team: { id: 'T0ACME', name: 'Acme' } } : { ok: false, error: 'invalid_code' });
      case 'GET slack.com/api/users.list': return Response.json({ ok: true, members: [
        { id: 'U1', profile: { email: 'dana@acme.example', real_name: 'Dana Katz' } },
        { id: 'U2', profile: { email: 'omer@acme.example', real_name: 'Omer Levi' } },
        { id: 'U3', is_bot: true, profile: { email: 'bot@acme.example' } }] });
      case 'POST slack.com/api/auth.revoke': state.revoked.push('slack'); return Response.json({ ok: true });
      case 'POST auth.atlassian.com/oauth/token':
        if (body.grant_type === 'refresh_token') {
          // Rotation: the old refresh token stops working.
          if (body.refresh_token !== state.atlassianRefresh) return Response.json({ error: 'invalid_grant' }, { status: 403 });
          state.refreshes++;
          state.atlassianRefresh = `refresh-${state.refreshes + 1}`;
          state.atlassianAccess = `access-${state.refreshes + 1}`;
        }
        return Response.json({ access_token: state.atlassianAccess, refresh_token: state.atlassianRefresh, expires_in: 3600 });
      case 'GET api.atlassian.com/oauth/token/accessible-resources':
        return Response.json([{ id: CLOUD, url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work', 'write:jira-work'] }]);
      case `GET api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/project/search`:
        return Response.json({ values: [{ key: 'WEB', name: 'Web' }, { key: 'OPS', name: 'Ops' }] });
      case `POST api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/search/jql`:
        state.jiraAuth.push(String((init?.headers as Record<string, string>).Authorization));
        return Response.json({ issues: [{ key: 'WEB-7', fields: { summary: 'Cache', status: { name: 'To Do' } } }] });
      case 'POST github.com/login/oauth/access_token': return Response.json({ access_token: 'gh-user' });
      case 'GET api.github.com/user/installations': return Response.json({ installations: [{ id: 777, account: { login: 'acme' } }] });
      case 'POST api.github.com/app/installations/777/access_tokens':
        return Response.json({ token: 'ghs-install', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      case 'GET api.github.com/installation/repositories':
        return Response.json({ repositories: [{ name: 'shop', owner: { login: 'acme' }, default_branch: 'main' }] });
      case 'DELETE api.github.com/app/installations/777': state.uninstalled.push('777'); return new Response(null, { status: 204 });
      case 'POST nogita-acme.cells.test/slack/events': {
        const headers = init?.headers as Record<string, string>;
        state.cellEvents.push({ body: String(init?.body), ok: verifySlackSignature(state.cellSecret, headers['X-Slack-Request-Timestamp']!,
          headers['X-Slack-Signature']!, String(init?.body)) });
        return new Response('', { status: 200 });
      }
    }
    if (url.hostname === '127.0.0.1') return fetch(input, init);
    return Response.json({ error: `no fake for ${route}` }, { status: 404 });
  }) as typeof fetch;
  return { state, fetcher };
}

async function start(fetcher: typeof fetch) {
  const store = new MemoryCompanyStore();
  const vault = new Vault(vaultKey);
  const provisioner = new MemoryProvisioner();
  let handler: ReturnType<typeof controlApp> | undefined;
  const server: Server = createServer((req, res) => void handler!(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const publicUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const broker = new TokenBroker(store, vault, apps, fetcher);
  const companies = new CompanyService({ store, vault, apps, provisioner, broker, publicUrl, http: fetcher });
  handler = controlApp({ store, vault, apps, companies, broker, publicUrl, sessionSecret: 's'.repeat(40),
    slackSigningSecret: SLACK_APP_SECRET, http: fetcher });

  // A browser: keeps cookies, does not follow redirects.
  const jar = new Map<string, string>();
  const browse = async (path: string, form?: Record<string, string | string[]>) => {
    const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => [k, x]))) : undefined;
    const response = await fetch(new URL(path, publicUrl), { method: form ? 'POST' : 'GET', redirect: 'manual', body,
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'); const [k, v] = pair!.split('=');
      if (/Max-Age=0/.test(line)) jar.delete(k!); else jar.set(k!, v!);
    }
    return { status: response.status, location: response.headers.get('location') ?? '', html: await response.text() };
  };
  /** Follows a provider round trip: our redirect out, the provider's redirect back with `params`. */
  const roundTrip = async (startPath: string, params: Record<string, string>) => {
    const out = await browse(startPath);
    const state = new URL(out.location).searchParams.get('state')!;
    const provider = startPath.split('/').at(-1)!;
    return browse(`/oauth/${provider}/callback?${new URLSearchParams({ ...params, state })}`);
  };
  const csrf = async () => (await browse('/app')).html.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { store, vault, provisioner, server, publicUrl, browse, roundTrip, csrf, jar };
}

test('control plane: from sign-in to a running cell, with each tool connected in one click', async t => {
  const { state, fetcher } = providers();
  const app = await start(fetcher);
  t.after(() => app.server.close());

  // Sign in and create the company.
  assert.equal((await app.browse('/app')).location, '/');
  const signedIn = await app.roundTrip('/login/google', { code: 'g-code' });
  assert.equal(signedIn.location, '/app');
  assert.match((await app.browse('/app')).html, /Company name/);
  assert.equal((await app.browse('/app/company', { name: 'Acme', csrf: 'wrong' })).status, 403);
  await app.browse('/app/company', { name: 'Acme', csrf: await app.csrf() });
  const company = () => app.store.get('acme')!;
  assert.deepEqual(company().members, [{ email: 'dana@acme.example', name: 'Dana Katz', role: 'admin' }]);

  // Tools.
  assert.match((await app.roundTrip('/connect/slack', { code: 'slack-code' })).location, /done=slack/);
  assert.match((await app.roundTrip('/connect/atlassian', { code: 'a-code' })).location, /done=atlassian/);
  assert.match((await app.roundTrip('/connect/github', { code: 'gh-code', installation_id: '777', setup_action: 'install' })).location, /done=github/);
  const kinds = company().connections.map(c => `${c.kind}:${c.id}`);
  assert.deepEqual(kinds, ['slack:slack', 'jira:jira-acme', 'github:github-acme']);
  assert.doesNotMatch(JSON.stringify(company()), /xoxb-acme|access-1|refresh-1/, 'tokens are only stored sealed');

  // The dashboard lists Jira projects and repositories to pick from.
  const page = (await app.browse('/app')).html;
  assert.match(page, /Web \(WEB\)/);
  assert.match(page, /acme\/shop/);
  const csrf = await app.csrf();
  await app.browse('/app/jira', { csrf, connection: 'jira-acme', project: 'WEB', read: ['OPS'] });
  await app.browse('/app/repos', { csrf, connection: 'github-acme', repo: ['acme/shop@main'] });
  await app.browse('/app/keys', { csrf, anthropic: 'sk-ant-acme', deepgram: 'dg-acme', attendee: 'att-acme', attendeeWebhookSecret: 'whsec', privacy: 'on' });
  await app.browse('/app/people/sync', { csrf });
  assert.deepEqual(company().people.map(p => [p.id, p.authorized, p.slack?.userId]), [['dana', true, 'U1'], ['omer', false, 'U2']]);
  await app.browse('/app/people', { csrf, authorized: ['dana', 'omer'] });

  // Start the cell.
  assert.match(decodeURIComponent((await app.browse('/app/cell', { csrf })).location), /Nogita is starting/);
  const [[serviceId, cell]] = [...app.provisioner.cells];
  assert.equal(cell!.deploys, 2, 'created, then given its own address');
  const env = cell!.env;
  assert.equal(env.NOGITA_STATE_PERSISTENT, 'true');
  assert.equal(env.ATTENDEE_WEBHOOK_URL, 'https://nogita-acme.cells.test/webhooks/attendee');
  assert.equal(env.ATTENDEE_AUDIO_WEBSOCKET_URL, 'wss://nogita-acme.cells.test/webhooks/attendee/audio');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-acme');
  assert.equal(env.ATTENDEE_PRIVACY_REVIEWED, 'true');
  assert.doesNotMatch(env.NOGITA_TENANT_CONFIG!, /sk-ant|xoxb|access-|ghs-/, 'the company config holds references, not secrets');
  assert.match(decodeURIComponent((await app.browse('/app/cell', { csrf })).location), /Nothing changed/);

  // The cell reads its configuration, and its Jira board gets hour-long tokens from the broker, refreshed when due.
  const config = parseTenantConfig(env.NOGITA_TENANT_CONFIG!, env);
  assert.deepEqual(config.authorizedActorIds, ['dana', 'omer']);
  const deps = buildDependencies(config, new BrokerClient(env.NOGITA_BROKER_URL!, env.NOGITA_CELL_TOKEN!, fetcher));
  assert.ok(deps.board instanceof JiraBoard);
  const board = new JiraBoard({ baseUrl: 'https://acme.atlassian.net', cloudId: CLOUD, projectKey: 'WEB', issueType: 'Task',
    token: new BrokerClient(env.NOGITA_BROKER_URL!, env.NOGITA_CELL_TOKEN!, fetcher).source('jira-acme') }, fetcher);
  assert.equal((await board.searchTasks({}))[0]?.url, 'https://acme.atlassian.net/browse/WEB-7');
  assert.equal(state.jiraAuth.at(-1), 'Bearer access-1');
  const stored = app.store.get('acme')!;
  const jira = stored.connections.find(c => c.kind === 'jira')!;
  if (jira.kind === 'jira') jira.expiresAt = Date.now() - 1;
  app.store.put(stored);
  const fresh = new BrokerClient(env.NOGITA_BROKER_URL!, env.NOGITA_CELL_TOKEN!, fetcher);
  const [a, b] = await Promise.all([fresh.token('jira-acme'), fresh.token('jira-acme')]);
  assert.equal(a, 'access-2'); assert.equal(b, 'access-2');
  assert.equal(state.refreshes, 1, 'one refresh, and the rotated refresh token was kept');
  assert.equal(await new BrokerClient(env.NOGITA_BROKER_URL!, env.NOGITA_CELL_TOKEN!, fetcher).token('github-acme'), 'ghs-install');
  await assert.rejects(() => new BrokerClient(env.NOGITA_BROKER_URL!, 'x'.repeat(40), fetcher).token('jira-acme'), /HTTP 403/);

  // Slack events reach the cell, signed with the cell's own secret.
  state.cellSecret = env.SLACK_SIGNING_SECRET!;
  const event = JSON.stringify({ type: 'event_callback', team_id: 'T0ACME', event: { type: 'app_mention', text: 'hi' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const routed = await fetch(`${app.publicUrl}/slack/events`, { method: 'POST', body: event,
    headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signForCell(SLACK_APP_SECRET, ts, event) } });
  assert.equal(routed.status, 200);
  assert.deepEqual(state.cellEvents, [{ body: event, ok: true }]);
  const forged = await fetch(`${app.publicUrl}/slack/events`, { method: 'POST', body: event,
    headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': 'v0=bad' } });
  assert.equal(forged.status, 401);
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  assert.equal(await (await fetch(`${app.publicUrl}/slack/events`, { method: 'POST', body: challenge,
    headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signForCell(SLACK_APP_SECRET, ts, challenge) } })).text(), 'abc');

  // Deleting removes the cell, revokes Slack, uninstalls GitHub, and drops every secret.
  await app.browse('/app/delete', { csrf: await app.csrf() });
  assert.equal(app.store.get('acme'), undefined);
  assert.equal(app.provisioner.cells.has(serviceId!), false);
  assert.deepEqual(state.revoked, ['slack']);
  assert.deepEqual(state.uninstalled, ['777']);
});

test('control plane: callbacks must come back to the browser and company that started them', async t => {
  const { fetcher } = providers();
  const app = await start(fetcher);
  t.after(() => app.server.close());
  await app.roundTrip('/login/google', { code: 'g-code' });
  await app.browse('/app/company', { name: 'Acme', csrf: await app.csrf() });
  // A callback with a state from somewhere else, or without this browser's nonce, does nothing.
  const out = await app.browse('/connect/slack');
  const state = new URL(out.location).searchParams.get('state')!;
  app.jar.delete('nogita_oauth');
  assert.equal((await app.browse(`/oauth/slack/callback?code=slack-code&state=${encodeURIComponent(state)}`)).status, 400);
  assert.equal(app.store.get('acme')!.connections.length, 0);
  // A GitHub installation the person cannot see is refused.
  const foreign = await app.roundTrip('/connect/github', { code: 'gh-code', installation_id: '999' });
  assert.match(decodeURIComponent(foreign.location), /not one you can see/);
  // A second company cannot take over a Slack workspace another company connected.
  await app.roundTrip('/connect/slack', { code: 'slack-code' });
  const other: Company = { ...app.store.get('acme')!, id: 'globex', name: 'Globex', connections: [], members: [] };
  app.store.put(other);
  assert.throws(() => new CompanyService({ store: app.store, vault: app.vault, apps, provisioner: app.provisioner,
    broker: new TokenBroker(app.store, app.vault, apps), publicUrl: app.publicUrl })
    .connectSlack(other, { teamId: 'T0ACME', teamName: 'Acme', botUserId: 'U', botToken: 'xoxb-x' }, 'x@globex.example'), /another company/);
});

test('control plane: a member who is not an admin can look but not change anything', async t => {
  const { fetcher } = providers();
  const app = await start(fetcher);
  t.after(() => app.server.close());
  await app.roundTrip('/login/google', { code: 'g-code' });
  await app.browse('/app/company', { name: 'Acme', csrf: await app.csrf() });
  const csrf = await app.csrf();
  const company = app.store.get('acme')!;
  company.members[0]!.role = 'member';
  app.store.put(company);
  const page = (await app.browse('/app')).html;
  assert.match(page, /Ask an admin/);
  assert.doesNotMatch(page, /Anthropic API key/);
  assert.equal((await app.browse('/app/keys', { csrf, anthropic: 'sk-ant-x' })).status, 403);
  assert.equal(app.store.get('acme')!.keys.anthropic, undefined);
});
