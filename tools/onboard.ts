/**
 * Onboarding a pilot team without touching code: checks their tenant config, then calls each provider with it the way
 * readiness does, and prints what is still missing, one line each. docs/ONBOARDING.md walks through the steps.
 *
 *   npm run onboard -- --template > acme.json      a config to fill in (secrets stay "env:NAME" references)
 *   npm run onboard -- --config acme.json          check it, and call Jira, GitHub, Slack, Anthropic, Deepgram, Attendee
 *   npm run onboard -- --config acme.json --offline   check the file only
 *
 * Without --config it checks NOGITA_TENANT_CONFIG, or the single-company environment. Exit code 1 while anything is missing.
 */
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../src/app/config.ts';
import { probeConnections } from '../src/app/connection-probes.ts';
import type { ConnectionCheck, ConnectionReadinessReport } from '../src/app/readiness.ts';
import { loadTenantConfig, type TenantConfig } from '../src/app/tenant-config.ts';

export interface OnboardingItem { area: string; status: 'ok' | 'missing' | 'optional'; detail: string }

/** Where to start: every field a pilot team fills in, with secrets as references to their environment. */
export const TEMPLATE = {
  tenant: { id: 'acme', name: 'Acme', timeZone: 'Asia/Jerusalem', weekStartsOn: 'sunday' },
  ai: { mode: 'live', anthropicApiKey: 'env:ACME_ANTHROPIC_API_KEY' },
  boards: [{ id: 'web', provider: 'jira', default: true, baseUrl: 'https://acme.atlassian.net', email: 'nogita-bot@acme.example',
    token: 'env:ACME_JIRA_TOKEN', projectKey: 'WEB' }],
  repositories: [{ id: 'shop', provider: 'github', owner: 'acme', repo: 'shop', ref: 'main', token: 'env:ACME_GITHUB_TOKEN' }],
  chat: { provider: 'slack', botToken: 'env:ACME_SLACK_BOT_TOKEN' },
  people: [{ id: 'dana', displayName: 'Dana Katz', email: 'dana@acme.example', jiraAccountId: 'replace-with-jira-account-id' }],
  authorizedActorIds: ['dana'],
};

const isBroker = (token: string | undefined) => token?.startsWith('broker:') ?? false;

/**
 * The single-company variables connection-probes.ts reads, filled from the config's default board, first GitHub
 * repository, Slack and AI key; Deepgram and Attendee are infrastructure and stay as the environment has them.
 * A token the control plane's broker holds cannot be probed from here, so that provider is left unconfigured.
 */
export function probeEnvironment(config: TenantConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const jira = [...config.boards].sort((a, b) => Number(b.default === true) - Number(a.default === true)).find(board => board.provider === 'jira');
  const github = config.repositories.find(repo => repo.provider === 'github');
  return {
    ...(env.DEEPGRAM_API_KEY ? { DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY } : {}),
    ...(env.ATTENDEE_API_KEY ? { ATTENDEE_API_KEY: env.ATTENDEE_API_KEY } : {}),
    ...(env.NOGITA_REALTIME_AUDIO_ENABLED ? { NOGITA_REALTIME_AUDIO_ENABLED: env.NOGITA_REALTIME_AUDIO_ENABLED } : {}),
    ...(jira?.provider === 'jira' && jira.email && !isBroker(jira.token)
      ? { JIRA_BASE_URL: jira.baseUrl, JIRA_EMAIL: jira.email, JIRA_API_TOKEN: jira.token, JIRA_PROJECT_KEY: jira.projectKey } : {}),
    ...(github?.provider === 'github' && !isBroker(github.token)
      ? { GITHUB_OWNER: github.owner, GITHUB_REPO: github.repo, GITHUB_REF: github.ref ?? 'main', ...(github.token ? { GITHUB_TOKEN: github.token } : {}) } : {}),
    ...(config.chat && !isBroker(config.chat.botToken) ? { SLACK_BOT_TOKEN: config.chat.botToken } : {}),
    ...(config.ai.anthropicApiKey ? { ANTHROPIC_API_KEY: config.ai.anthropicApiKey } : {}),
  };
}

/** What the config itself says: everything a team needs before its first meeting, and what is only nice to have. */
export function checkConfig(config: TenantConfig): OnboardingItem[] {
  const items: OnboardingItem[] = [];
  const add = (area: string, status: OnboardingItem['status'], detail: string) => items.push({ area, status, detail });
  add('Team', 'ok', `${config.tenant.name} (${config.tenant.id})`);
  if (config.tenant.timeZone) add('Time zone', 'ok', `${config.tenant.timeZone}, week starts ${config.tenant.weekStartsOn ?? 'monday'}`);
  else add('Time zone', 'missing', 'tenant.timeZone is not set, so "today" and "this week" are in UTC.');
  if (config.ai.mode === 'live' && config.ai.anthropicApiKey) add('AI', 'ok', 'live, with an Anthropic key');
  else add('AI', 'missing', config.ai.mode !== 'live' ? 'ai.mode is "demo": she gives canned answers. Set it to "live".' : 'ai.anthropicApiKey is not set.');
  const boards = config.boards.filter(board => board.provider !== 'demo');
  if (boards.length) {
    const target = boards.find(board => board.default) ?? boards[0]!;
    add('Board', 'ok', `${boards.map(board => `${board.id} (${board.provider})`).join(', ')}; new tasks go to ${target.id}`);
  } else add('Board', 'missing', 'No Jira or monday.com board: she cannot read or open tasks.');
  const repositories = config.repositories.filter(repo => repo.provider === 'github');
  if (!repositories.length) add('Repository', 'missing', 'No GitHub repository: she cannot answer about the code.');
  else for (const repo of repositories) {
    if (repo.provider !== 'github') continue;
    add('Repository', repo.token || repo.publicRepo ? 'ok' : 'missing',
      `${repo.owner}/${repo.repo}@${repo.ref ?? 'main'}${repo.token || repo.publicRepo ? '' : ': needs a token, or publicRepo: true for a public one'}`);
  }
  if (config.chat) add('Slack', 'ok', 'a bot token is set');
  else add('Slack', 'optional', 'No Slack: no chat threads, no hand-off from a meeting to Slack.');
  if (!config.people.length) add('People', 'missing', 'No people: she cannot tell who is speaking or assign tasks.');
  else {
    add('People', 'ok', `${config.people.length} listed`);
    const unassignable = config.people.filter(person => !person.jiraAccountId && !person.accounts && boards.some(board => board.provider === 'jira'));
    if (unassignable.length) add('People', 'optional', `No Jira account for ${unassignable.map(person => person.displayName).join(', ')}: tasks cannot be assigned to them.`);
  }
  const known = new Set(config.people.map(person => person.id));
  const unknown = config.authorizedActorIds.filter(id => !known.has(id));
  if (!config.authorizedActorIds.length) add('Who may act', 'missing', 'authorizedActorIds is empty: nobody may read the code or open tasks.');
  else if (unknown.length) add('Who may act', 'missing', `Not in people: ${unknown.join(', ')}.`);
  else add('Who may act', 'ok', config.authorizedActorIds.join(', '));
  return items;
}

const PROBE_AREA: Record<ConnectionCheck['provider'], string> = { github: 'GitHub', jira: 'Jira', slack: 'Slack', anthropic: 'Anthropic',
  deepgram: 'Deepgram (voice)', attendee: 'Attendee (joins meetings)' };
/** Providers a team can start without: chat-only pilots need neither voice nor the meeting bot. */
const OPTIONAL_PROBES = new Set<ConnectionCheck['provider']>(['slack', 'deepgram', 'attendee']);

/** The live calls, one line each: connected, or what went wrong (never a secret). */
export function checkConnections(report: ConnectionReadinessReport): OnboardingItem[] {
  return report.checks.map(check => {
    const area = `${PROBE_AREA[check.provider]} connection`;
    if (check.status === 'connected') return { area, status: 'ok', detail: `answered in ${check.durationMs ?? '?'} ms` };
    if (check.status === 'not_required') return { area, status: 'ok', detail: 'not needed' };
    if (check.status === 'unconfigured') return { area, status: OPTIONAL_PROBES.has(check.provider) ? 'optional' : 'missing', detail: 'not configured' };
    const why = check.status === 'invalid_configuration' ? 'the settings are not valid (check the URL or ids)'
      : check.status === 'unreachable' ? 'could not reach it' : `it refused${check.httpStatus ? ` (HTTP ${check.httpStatus})` : ''}: check the token and its permissions`;
    return { area, status: 'missing', detail: why };
  });
}

export function formatItems(items: readonly OnboardingItem[]): string {
  const mark = { ok: '✓', missing: '✗', optional: '·' } as const;
  const missing = items.filter(item => item.status === 'missing');
  return [...items.map(item => `${mark[item.status]} ${item.area.padEnd(37)} ${item.detail}`), '',
    missing.length ? `${missing.length} thing(s) to fix before the first meeting.` : 'Ready for a first meeting.', ''].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, offline: { type: 'boolean', default: false },
    template: { type: 'boolean', default: false } } });
  if (values.template) { process.stdout.write(`${JSON.stringify(TEMPLATE, null, 2)}\n`); return; }
  loadDotEnv();
  const env = { ...process.env, ...(values.config ? { NOGITA_TENANT_CONFIG: values.config } : {}) };
  let config: TenantConfig;
  try { config = loadTenantConfig(env); }
  catch (error) {
    process.stdout.write(formatItems([{ area: 'Config', status: 'missing', detail: error instanceof Error ? error.message : String(error) }]));
    process.exitCode = 1;
    return;
  }
  const items = checkConfig(config);
  if (!values.offline) items.push(...checkConnections(await probeConnections(probeEnvironment(config, env))));
  process.stdout.write(formatItems(items));
  process.exitCode = items.some(item => item.status === 'missing') ? 1 : 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/onboard.ts')) await main();
