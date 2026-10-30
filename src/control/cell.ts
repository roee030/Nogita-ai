/**
 * What a company's cell is given: its company configuration (the same JSON a hand-run install uses, see
 * config/tenant.example.json) and its environment. The configuration holds no secret: tokens are "env:NAME" for
 * the fixed ones the environment carries, and "broker:<connection>" for ones that expire.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Cell, Company } from './store.ts';
import type { Vault } from './vault.ts';

/** Where the cell keeps its state: on its own disk. */
export const CELL_DISK_MOUNT = '/var/data';
const STATE_DIR = `${CELL_DISK_MOUNT}/nogita`;

export function newCellSecrets(vault: Vault, companyId: string): { secrets: Cell['secrets']; cellToken: string } {
  const random = (bytes: number) => randomBytes(bytes).toString('base64url');
  const cellToken = random(32);
  return { cellToken, secrets: {
    adminToken: vault.seal(companyId, random(32)),
    queueKey: vault.seal(companyId, randomBytes(32).toString('base64')),
    cellToken: vault.seal(companyId, cellToken),
    slackSigningSecret: vault.seal(companyId, random(32)),
  } };
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'x';

/** The company configuration for the cell, built from what the admin connected and chose. */
export function tenantConfigFor(company: Company): Record<string, unknown> {
  const boards = company.connections.flatMap(c => c.kind === 'jira' && c.projectKey
    ? [{ id: c.id, provider: 'jira', baseUrl: c.siteUrl, cloudId: c.cloudId, token: `broker:${c.id}`, projectKey: c.projectKey,
        readProjectKeys: c.readProjectKeys ?? [] }] : []);
  const taken = new Set<string>();
  const repositories = company.connections.flatMap(c => c.kind === 'github' ? c.repositories.map(r => {
    let id = slug(r.repo);
    for (let n = 2; taken.has(id); n++) id = `${slug(r.repo)}-${n}`;
    taken.add(id);
    return { id, provider: 'github', owner: r.owner, repo: r.repo, ref: r.ref, token: `broker:${c.id}` };
  }) : []);
  const slack = company.connections.find(c => c.kind === 'slack');
  return {
    tenant: { id: company.id, name: company.name },
    ai: company.keys.anthropic ? { mode: 'live', anthropicApiKey: 'env:ANTHROPIC_API_KEY', agent: true } : { mode: 'demo' },
    boards, repositories,
    ...(slack ? { chat: { id: 'slack', provider: 'slack', botToken: 'env:SLACK_BOT_TOKEN' } } : {}),
    people: company.people.map(p => ({ id: p.id, displayName: p.displayName, email: p.email, ...(p.slack ? { slack: p.slack } : {}) })),
    authorizedActorIds: company.people.filter(p => p.authorized).map(p => p.id),
  };
}

/** The cell's environment. `cellUrl` is unknown on the very first create, and set by the update that follows. */
export function cellEnvironment(company: Company, cell: Pick<Cell, 'secrets'>, vault: Vault,
  options: { brokerUrl: string; cellUrl?: string }): Record<string, string> {
  const open = (sealed: Parameters<Vault['open']>[1]) => vault.open(company.id, sealed);
  const env: Record<string, string> = {
    HOST: '0.0.0.0',
    NOGITA_TENANT_CONFIG: JSON.stringify(tenantConfigFor(company)),
    NOGITA_ADMIN_TOKEN: open(cell.secrets.adminToken),
    NOGITA_QUEUE_ENCRYPTION_KEY: open(cell.secrets.queueKey),
    NOGITA_STATE_DIR: STATE_DIR,
    NOGITA_STATE_PERSISTENT: 'true',
    NOGITA_BROKER_URL: options.brokerUrl,
    NOGITA_CELL_TOKEN: open(cell.secrets.cellToken),
  };
  if (company.keys.anthropic) Object.assign(env, { NOGITA_MODE: 'live', ANTHROPIC_API_KEY: open(company.keys.anthropic) });
  const slack = company.connections.find(c => c.kind === 'slack');
  if (slack?.kind === 'slack') {
    Object.assign(env, { SLACK_BOT_TOKEN: open(slack.botToken), SLACK_BOT_USER_ID: slack.botUserId,
      SLACK_ALLOWED_TEAM_IDS: slack.teamId,
      // Slack events reach the cell through the control plane, signed again with the cell's own secret.
      SLACK_SIGNING_SECRET: open(cell.secrets.slackSigningSecret) });
  }
  if (company.keys.attendee && company.keys.attendeeWebhookSecret) {
    Object.assign(env, { MEETING_PROVIDER: 'attendee', ATTENDEE_API_KEY: open(company.keys.attendee),
      ATTENDEE_WEBHOOK_SECRET: open(company.keys.attendeeWebhookSecret),
      ATTENDEE_PRIVACY_REVIEWED: company.meetingPrivacyReviewed ? 'true' : 'false' });
    if (options.cellUrl) {
      const wss = options.cellUrl.replace(/^https:/, 'wss:');
      Object.assign(env, { NOGITA_PUBLIC_URL: options.cellUrl, ATTENDEE_WEBHOOK_URL: `${options.cellUrl}/webhooks/attendee` });
      if (company.keys.deepgram) {
        Object.assign(env, { NOGITA_REALTIME_AUDIO_ENABLED: 'true', DEEPGRAM_API_KEY: open(company.keys.deepgram),
          ATTENDEE_AUDIO_WEBSOCKET_URL: `${wss}/webhooks/attendee/audio` });
      }
    }
  }
  return env;
}

/** Changes when anything the cell is given changes, so the control plane knows to update it. */
export function environmentHash(env: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(env).sort()) hash.update(`${key}\0${env[key]}\0`);
  return hash.digest('hex');
}
