import type { IdentityDirectory } from '../core/identity.ts';

export interface ReadinessCheck {
  id: 'runtime' | 'admin_auth' | 'provider_config' | 'durable_queue' | 'slack' | 'jira' | 'github' | 'attendee' | 'reasoning';
  status: 'ready' | 'blocked';
  detail: string;
}

export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessCheck[];
  blockers: ReadinessCheck['id'][];
}

function present(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.every(name => Boolean(env[name]?.trim()));
}

function supportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(part => Number.parseInt(part, 10));
  return major > 22 || (major === 22 && minor >= 16);
}

export function validAdminToken(value: string | undefined): boolean {
  return Boolean(value && value.length >= 20 && !value.startsWith('replace-'));
}

function validHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validQueueKey(value: string | undefined): boolean {
  if (!value) return false;
  try { return Buffer.from(value, 'base64').length === 32; } catch { return false; }
}

function check(id: ReadinessCheck['id'], ready: boolean, readyDetail: string, blockedDetail: string): ReadinessCheck {
  return { id, status: ready ? 'ready' : 'blocked', detail: ready ? readyDetail : blockedDetail };
}

export function buildReadinessReport(
  env: NodeJS.ProcessEnv,
  identities: IdentityDirectory,
  nodeVersion = process.versions.node,
  providerConfigValid = true,
  slackSocketConnected = false,
): ReadinessReport {
  const hasAuthorizedOwner = (env.AUTHORIZED_ACTOR_IDS ?? '').split(',')
    .map(id => id.trim()).filter(Boolean).some(id => Boolean(identities.fromId(id)));
  const slackCommon = Boolean(env.SLACK_BOT_TOKEN?.startsWith('xoxb-')) &&
    present(env, ['SLACK_ALLOWED_TEAM_IDS', 'SLACK_BOT_USER_ID']);
  const slackSocketModeReady = slackCommon && Boolean(env.SLACK_APP_TOKEN?.startsWith('xapp-')) && slackSocketConnected;
  const slackEventsMode = slackCommon && Boolean(env.SLACK_SIGNING_SECRET?.trim());
  const checks: ReadinessCheck[] = [
    check('runtime', supportedNode(nodeVersion), 'The Node.js runtime is supported.',
      'Upgrade the runtime to Node.js 22.16 or newer.'),
    check('admin_auth', validAdminToken(env.NOGITA_ADMIN_TOKEN),
      'HTTP administration authentication is configured.',
      'Set a strong local or deployment NOGITA_ADMIN_TOKEN before starting the HTTP service.'),
    check('provider_config', providerConfigValid, 'Selected provider adapters accepted their configuration.',
      'Correct invalid provider configuration before processing events or sessions.'),
    check('durable_queue', validQueueKey(env.NOGITA_QUEUE_ENCRYPTION_KEY),
      'The encrypted durable event queue is configured.',
      'Set NOGITA_QUEUE_ENCRYPTION_KEY to 32 random base64-encoded bytes in deployment secrets.'),
    check('slack', slackEventsMode || slackSocketModeReady,
      slackSocketModeReady ? 'Slack Socket Mode is connected.' : 'Signed Slack Events API configuration is complete for the HTTP service.',
      'Configure signed Events API for POST /slack/events or provide Socket Mode credentials and wait for the WebSocket connection.'),
    check('jira', env.BOARD_PROVIDER === 'jira' &&
      present(env, ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']),
      'Jira is selected and its required configuration is present.',
      'Select Jira and configure its site, account email, API token, and project key.'),
    check('github', env.REPO_PROVIDER === 'github' && present(env, ['GITHUB_OWNER', 'GITHUB_REPO']) &&
      (Boolean(env.GITHUB_TOKEN?.trim()) || env.GITHUB_PUBLIC_REPO === 'true'),
      'GitHub is selected and its required configuration is present.',
      'Select GitHub, configure owner/repository, and provide either a repository-scoped read token or explicit public-repository mode.'),
    check('attendee', env.MEETING_PROVIDER === 'attendee' && present(env, ['ATTENDEE_API_KEY', 'ATTENDEE_WEBHOOK_SECRET']) &&
      env.ATTENDEE_PRIVACY_REVIEWED === 'true' && validHttpsUrl(env.ATTENDEE_WEBHOOK_URL) &&
      (identities.hasAttendeeIdentity() || hasAuthorizedOwner),
      'Attendee webhook, privacy gate, and an authorized meeting identity are configured.',
      'Complete Attendee API/webhook setup, privacy review, stable HTTPS, and configure an authorized internal meeting owner or a stable speaker identity.'),
    check('reasoning', env.NOGITA_MODE === 'live' && present(env, ['ANTHROPIC_API_KEY']),
      'The live reasoning provider is configured.',
      'Enable live mode and configure the reasoning provider key; the model has a maintained low-cost default.'),
  ];
  const blockers = checks.filter(item => item.status === 'blocked').map(item => item.id);
  return { ok: blockers.length === 0, checks, blockers };
}
