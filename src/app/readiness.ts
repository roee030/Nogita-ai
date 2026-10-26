import type { IdentityDirectory } from '../core/identity.ts';

export interface ReadinessCheck {
  id: 'runtime' | 'provider_config' | 'slack' | 'jira' | 'github' | 'attendee' | 'reasoning';
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

function validHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function check(id: ReadinessCheck['id'], ready: boolean, readyDetail: string, blockedDetail: string): ReadinessCheck {
  return { id, status: ready ? 'ready' : 'blocked', detail: ready ? readyDetail : blockedDetail };
}

export function buildReadinessReport(
  env: NodeJS.ProcessEnv,
  identities: IdentityDirectory,
  nodeVersion = process.versions.node,
  providerConfigValid = true,
): ReadinessReport {
  const slackCommon = Boolean(env.SLACK_BOT_TOKEN?.startsWith('xoxb-')) &&
    present(env, ['SLACK_ALLOWED_TEAM_IDS', 'SLACK_BOT_USER_ID']);
  const slackSocketMode = slackCommon && Boolean(env.SLACK_APP_TOKEN?.startsWith('xapp-'));
  const slackEventsMode = slackCommon && Boolean(env.SLACK_SIGNING_SECRET?.trim());
  const checks: ReadinessCheck[] = [
    check('runtime', supportedNode(nodeVersion), 'The Node.js runtime is supported.',
      'Upgrade the runtime to Node.js 22.16 or newer.'),
    check('provider_config', providerConfigValid, 'Selected provider adapters accepted their configuration.',
      'Correct invalid provider configuration before processing events or sessions.'),
    check('slack', slackSocketMode || slackEventsMode,
      'Slack Socket Mode or signed Events API configuration is complete.',
      'Configure the common Slack bot/workspace values plus either an app token or signing secret.'),
    check('jira', env.BOARD_PROVIDER === 'jira' &&
      present(env, ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']),
      'Jira is selected and its required configuration is present.',
      'Select Jira and configure its site, account email, API token, and project key.'),
    check('github', env.REPO_PROVIDER === 'github' &&
      present(env, ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']),
      'GitHub is selected and its required configuration is present.',
      'Select GitHub and configure a repository-scoped read token, owner, and repository.'),
    check('attendee', env.MEETING_PROVIDER === 'attendee' && present(env, ['ATTENDEE_API_KEY', 'ATTENDEE_WEBHOOK_SECRET']) &&
      env.ATTENDEE_PRIVACY_REVIEWED === 'true' && validHttpsUrl(env.ATTENDEE_WEBHOOK_URL) &&
      identities.hasAttendeeIdentity(),
      'Attendee webhook, privacy gate, and at least one stable speaker identity are configured.',
      'Complete Attendee API/webhook setup, privacy review, stable HTTPS, and speaker identity enrollment.'),
    check('reasoning', env.NOGITA_MODE === 'live' && present(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']),
      'The live reasoning provider is configured.',
      'Enable live mode and configure the reasoning provider key and model.'),
  ];
  const blockers = checks.filter(item => item.status === 'blocked').map(item => item.id);
  return { ok: blockers.length === 0, checks, blockers };
}
