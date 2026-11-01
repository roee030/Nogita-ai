import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTenantConfig } from '../src/app/tenant-config.ts';
import { probeConnections } from '../src/app/connection-probes.ts';
import { checkConfig, checkConnections, formatItems, probeEnvironment, TEMPLATE } from '../tools/onboard.ts';

const secrets = { ACME_ANTHROPIC_API_KEY: 'sk-ant-x', ACME_JIRA_TOKEN: 'jira-secret', ACME_GITHUB_TOKEN: 'gh-secret', ACME_SLACK_BOT_TOKEN: 'xoxb-1' };
const config = (change: (value: typeof TEMPLATE) => unknown = value => value) =>
  parseTenantConfig(JSON.stringify(change(structuredClone(TEMPLATE))), secrets);

test('the template is a valid tenant config, and filled in it has nothing missing', () => {
  const items = checkConfig(config());
  assert.deepEqual(items.filter(item => item.status === 'missing'), []);
  assert.ok(items.some(item => item.area === 'Board' && /new tasks go to web/.test(item.detail)));
  assert.match(formatItems(items), /Ready for a first meeting\./);
});

test('what is missing is said in plain words: demo AI, no board, a private repo with no token, someone allowed who is not listed', () => {
  const items = checkConfig(config(value => ({ ...value, tenant: { id: 'acme', name: 'Acme' }, ai: { mode: 'demo' }, boards: [],
    repositories: [{ id: 'shop', provider: 'github', owner: 'acme', repo: 'shop' }], chat: undefined, authorizedActorIds: ['dana', 'yossi'] })));
  const missing = Object.fromEntries(items.filter(item => item.status === 'missing').map(item => [item.area, item.detail]));
  assert.match(missing['Time zone']!, /UTC/);
  assert.match(missing.AI!, /demo/);
  assert.match(missing.Board!, /cannot read or open tasks/);
  assert.match(missing.Repository!, /needs a token/);
  assert.match(missing['Who may act']!, /Not in people: yossi/);
  assert.ok(items.some(item => item.area === 'Slack' && item.status === 'optional'));
  assert.match(formatItems(items), /5 thing\(s\) to fix/);
});

test('the live calls use the config\'s own connections, and never print a secret', async () => {
  const env = probeEnvironment(config(), { DEEPGRAM_API_KEY: 'dg', SOME_OTHER: 'x', JIRA_API_TOKEN: 'from-the-old-env' });
  assert.deepEqual(env, { DEEPGRAM_API_KEY: 'dg', JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'nogita-bot@acme.example',
    JIRA_API_TOKEN: 'jira-secret', JIRA_PROJECT_KEY: 'WEB', GITHUB_OWNER: 'acme', GITHUB_REPO: 'shop', GITHUB_REF: 'main',
    GITHUB_TOKEN: 'gh-secret', SLACK_BOT_TOKEN: 'xoxb-1', ANTHROPIC_API_KEY: 'sk-ant-x' });

  const seen: string[] = [];
  const http = (async (url: string | URL | Request) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('slack.com')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (href.includes('atlassian.net')) return new Response('', { status: 401 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const items = checkConnections(await probeConnections(env, http));
  assert.ok(seen.some(url => url.includes('acme.atlassian.net/rest/api/3/project/WEB')));
  assert.ok(seen.some(url => url.includes('/repos/acme/shop/')));
  const byArea = Object.fromEntries(items.map(item => [item.area, item]));
  assert.equal(byArea['Jira connection']!.status, 'missing');
  assert.match(byArea['Jira connection']!.detail, /refused \(HTTP 401\): check the token/);
  assert.equal(byArea['GitHub connection']!.status, 'ok');
  assert.equal(byArea['Attendee (joins meetings) connection']!.status, 'optional');
  assert.doesNotMatch(formatItems(items), /jira-secret|gh-secret|sk-ant|xoxb/);
});

test('a token the broker holds is not probed from here', () => {
  const env = probeEnvironment(config(value => ({ ...value, boards: [{ ...value.boards[0]!, token: 'broker:jira-acme' }] })),
    { BROKER: 'x' } as NodeJS.ProcessEnv);
  assert.equal(env.JIRA_API_TOKEN, undefined);
});
