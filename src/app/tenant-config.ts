/**
 * Everything that belongs to one company's Nogita, as one typed object: its boards, repositories, chat, people, who may
 * act, and its AI settings. Infrastructure (ports, the meeting vendor, storage) stays in the environment.
 *
 * Two sources: the environment (`tenantConfigFromEnv`, how a single deployment has always been configured) or a JSON
 * file named by NOGITA_TENANT_CONFIG (`parseTenantConfig`), which can hold several boards and repositories. In the
 * file, a secret is never written out: it is a reference, `"env:JIRA_API_TOKEN"`, read from the environment (where a
 * secrets manager puts it) when the file is loaded.
 */
import { readFileSync } from 'node:fs';
import { parseIdentityRecords, type IdentityRecord } from '../core/identity.ts';
import { isTimeZone } from '../core/team-time.ts';

export type BoardConnection = { id: string; default?: boolean } & (
  | { provider: 'jira'; baseUrl: string; email?: string; cloudId?: string; token: string; projectKey: string; issueType?: string;
      readProjectKeys?: string[]; assigneeAccountIds?: string[] }
  | { provider: 'monday'; token: string; boardId: number; descriptionColumnId: string }
  | { provider: 'demo' });

export type RepositoryConnection = { id: string } & (
  | { provider: 'github'; owner: string; repo: string; ref?: string; token?: string; publicRepo?: boolean;
      /** Draft pull requests on request (needs a token with Contents and Pull requests write). Off by default. */
      draftPullRequests?: boolean }
  | { provider: 'demo' });

export type ChatConnection = { id: string } & { provider: 'slack'; botToken: string; userToken?: string };

export interface AiConfig {
  mode: 'demo' | 'live';
  anthropicApiKey?: string;
  /** Planner model; the agent and code-reasoning models below default to the adapter's own choices. */
  model?: string;
  agentModel?: string;
  codeReasoningModel?: string;
  /** The tool-using conversational agent (off: the one-shot planner answers). */
  agent: boolean;
  agentThinking: boolean;
  maxCodeReasoningCallsPerSession: number;
  /** USD per million tokens, for the usage report. */
  prices: { input: number; output: number; agentInput: number; agentOutput: number; codeInput: number; codeOutput: number };
}

export interface TenantConfig {
  /** timeZone (IANA) and weekStartsOn set what "today" and "this week" mean; UTC and Monday when left out. */
  tenant: { id: string; name: string; timeZone?: string; weekStartsOn?: 'sunday' | 'monday' };
  ai: AiConfig;
  /** The first board marked `default` (else the first) is where new tasks go unless someone names another. */
  boards: BoardConnection[];
  repositories: RepositoryConnection[];
  chat?: ChatConnection;
  people: IdentityRecord[];
  /** Internal person ids who may read code and create tasks. */
  authorizedActorIds: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_PRICES: AiConfig['prices'] = { input: 0.10, output: 0.50, agentInput: 0.10, agentOutput: 0.50, codeInput: 3, codeOutput: 15 };

const list = (value: string | undefined) => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

function teamCalendar(timeZone: unknown, weekStartsOn: unknown, zonePath: string, weekPath: string):
    Pick<TenantConfig['tenant'], 'timeZone' | 'weekStartsOn'> {
  if (timeZone !== undefined && (typeof timeZone !== 'string' || !isTimeZone(timeZone))) {
    throw new ConfigError(zonePath, 'an IANA time zone such as Asia/Jerusalem');
  }
  if (weekStartsOn !== undefined && weekStartsOn !== 'sunday' && weekStartsOn !== 'monday') {
    throw new ConfigError(weekPath, 'sunday or monday');
  }
  return { ...(timeZone !== undefined ? { timeZone } : {}), ...(weekStartsOn !== undefined ? { weekStartsOn } : {}) };
}

/** The single-company configuration the environment has always described. */
export function tenantConfigFromEnv(env: NodeJS.ProcessEnv): TenantConfig {
  const boards: BoardConnection[] = env.BOARD_PROVIDER === 'jira'
    ? [{ id: 'jira', provider: 'jira', baseUrl: env.JIRA_BASE_URL ?? '', email: env.JIRA_EMAIL ?? '', token: env.JIRA_API_TOKEN ?? '',
        projectKey: env.JIRA_PROJECT_KEY ?? '', issueType: env.JIRA_ISSUE_TYPE ?? 'Task', readProjectKeys: list(env.JIRA_READ_PROJECT_KEYS),
        assigneeAccountIds: list(env.JIRA_ASSIGNEE_ACCOUNT_ID) }]
    : env.BOARD_PROVIDER === 'monday'
    ? [{ id: 'monday', provider: 'monday', token: env.MONDAY_API_TOKEN ?? '', boardId: Number(env.MONDAY_BOARD_ID ?? NaN),
        descriptionColumnId: env.MONDAY_DESCRIPTION_COLUMN_ID ?? '' }]
    : [];
  const repositories: RepositoryConnection[] = env.REPO_PROVIDER === 'github'
    ? [{ id: 'github', provider: 'github', owner: env.GITHUB_OWNER ?? '', repo: env.GITHUB_REPO ?? '', ref: env.GITHUB_REF ?? 'main',
        token: env.GITHUB_TOKEN ?? '', publicRepo: env.GITHUB_PUBLIC_REPO === 'true', draftPullRequests: env.GITHUB_DRAFT_PRS === 'true' }]
    : [];
  return {
    tenant: { id: env.NOGITA_TENANT_ID || 'default', name: env.NOGITA_TENANT_NAME || 'Default',
      ...teamCalendar(env.TEAM_TIMEZONE || undefined, env.TEAM_WEEK_START || undefined, 'TEAM_TIMEZONE', 'TEAM_WEEK_START') },
    ai: {
      mode: env.NOGITA_MODE === 'live' ? 'live' : 'demo',
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL, agentModel: env.ANTHROPIC_AGENT_MODEL, codeReasoningModel: env.ANTHROPIC_CODE_REASONING_MODEL,
      agent: env.NOGITA_AGENT !== 'off',
      agentThinking: env.ANTHROPIC_AGENT_THINKING === 'on',
      maxCodeReasoningCallsPerSession: num(env.ANTHROPIC_MAX_CODE_REASONING_CALLS_PER_SESSION, 3),
      prices: {
        input: num(env.ANTHROPIC_INPUT_USD_PER_MILLION, DEFAULT_PRICES.input),
        output: num(env.ANTHROPIC_OUTPUT_USD_PER_MILLION, DEFAULT_PRICES.output),
        agentInput: num(env.ANTHROPIC_AGENT_INPUT_USD_PER_MILLION, DEFAULT_PRICES.agentInput),
        agentOutput: num(env.ANTHROPIC_AGENT_OUTPUT_USD_PER_MILLION, DEFAULT_PRICES.agentOutput),
        codeInput: num(env.ANTHROPIC_CODE_INPUT_USD_PER_MILLION, DEFAULT_PRICES.codeInput),
        codeOutput: num(env.ANTHROPIC_CODE_OUTPUT_USD_PER_MILLION, DEFAULT_PRICES.codeOutput),
      },
    },
    boards,
    repositories,
    ...(env.SLACK_BOT_TOKEN?.startsWith('xoxb-')
      ? { chat: { id: 'slack', provider: 'slack' as const, botToken: env.SLACK_BOT_TOKEN,
          ...(env.SLACK_USER_TOKEN?.startsWith('xoxp-') ? { userToken: env.SLACK_USER_TOKEN } : {}) } }
      : {}),
    people: env.IDENTITY_MAP_JSON ? parseIdentityRecords(env.IDENTITY_MAP_JSON) : [],
    authorizedActorIds: list(env.AUTHORIZED_ACTOR_IDS ?? 'demo-lead'),
  };
}

class ConfigError extends Error {
  constructor(path: string, problem: string) { super(`tenant config ${path}: ${problem}`); this.name = 'TenantConfigError'; }
}

/** Replaces every `"env:NAME"` string with that variable; a missing variable is an error that names it. */
function resolveSecrets(value: unknown, env: NodeJS.ProcessEnv, path: string): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) return value;
    const secret = env[match[1]!];
    if (secret === undefined || secret === '') throw new ConfigError(path, `environment variable ${match[1]} is not set`);
    return secret;
  }
  if (Array.isArray(value)) return value.map((item, i) => resolveSecrets(item, env, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSecrets(item, env, `${path}.${key}`)]));
  }
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(path, 'expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (!optional && !value.trim())) throw new ConfigError(path, 'expected text');
  return value.trim();
}
function texts(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(path, 'expected a list');
  return value.map((item, i) => text(item, `${path}[${i}]`));
}
function connectionId(value: unknown, path: string, seen: Set<string>): string {
  const id = text(value, path);
  if (!ID.test(id)) throw new ConfigError(path, 'ids are lowercase letters, digits and dashes, up to 32 characters');
  if (seen.has(id)) throw new ConfigError(path, `duplicate id "${id}"`);
  seen.add(id);
  return id;
}

function parseBoard(raw: unknown, path: string, seen: Set<string>): BoardConnection {
  const b = object(raw, path);
  const base = { id: connectionId(b.id, `${path}.id`, seen), ...(b.default === true ? { default: true } : {}) };
  switch (b.provider) {
    // Connected with OAuth, a site is named by its cloud id and the token comes from the broker; else an account email and API token.
    case 'jira': return { ...base, provider: 'jira', baseUrl: text(b.baseUrl, `${path}.baseUrl`),
      ...(b.cloudId !== undefined ? { cloudId: text(b.cloudId, `${path}.cloudId`) } : { email: text(b.email, `${path}.email`) }),
      token: text(b.token, `${path}.token`), projectKey: text(b.projectKey, `${path}.projectKey`),
      issueType: text(b.issueType, `${path}.issueType`, true) || 'Task', readProjectKeys: texts(b.readProjectKeys, `${path}.readProjectKeys`),
      assigneeAccountIds: texts(b.assigneeAccountIds, `${path}.assigneeAccountIds`) };
    case 'monday': return { ...base, provider: 'monday', token: text(b.token, `${path}.token`), boardId: Number(b.boardId),
      descriptionColumnId: text(b.descriptionColumnId, `${path}.descriptionColumnId`) };
    case 'demo': return { ...base, provider: 'demo' };
    default: throw new ConfigError(`${path}.provider`, `unknown board provider ${JSON.stringify(b.provider)} (jira, monday, demo)`);
  }
}

function parseRepository(raw: unknown, path: string, seen: Set<string>): RepositoryConnection {
  const r = object(raw, path);
  const id = connectionId(r.id, `${path}.id`, seen);
  switch (r.provider) {
    case 'github': return { id, provider: 'github', owner: text(r.owner, `${path}.owner`), repo: text(r.repo, `${path}.repo`),
      ref: text(r.ref, `${path}.ref`, true) || 'main', token: text(r.token, `${path}.token`, true), publicRepo: r.publicRepo === true,
      draftPullRequests: r.draftPullRequests === true };
    case 'demo': return { id, provider: 'demo' };
    default: throw new ConfigError(`${path}.provider`, `unknown repository provider ${JSON.stringify(r.provider)} (github, demo)`);
  }
}

/** A tenant config file's contents, with secret references resolved. Throws a message that says which field is wrong. */
export function parseTenantConfig(raw: string, env: NodeJS.ProcessEnv): TenantConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError('', 'not valid JSON'); }
  const c = object(resolveSecrets(parsed, env, ''), '');
  const tenant = object(c.tenant, 'tenant');
  const tenantId = text(tenant.id, 'tenant.id');
  if (!ID.test(tenantId)) throw new ConfigError('tenant.id', 'lowercase letters, digits and dashes, up to 32 characters');
  const ai = c.ai === undefined ? {} : object(c.ai, 'ai');
  const prices = ai.prices === undefined ? {} : object(ai.prices, 'ai.prices');
  const price = (key: keyof AiConfig['prices']) => {
    const value = prices[key];
    if (value === undefined) return DEFAULT_PRICES[key];
    if (typeof value !== 'number' || !(value >= 0)) throw new ConfigError(`ai.prices.${key}`, 'expected a number');
    return value;
  };
  if (ai.mode !== undefined && ai.mode !== 'live' && ai.mode !== 'demo') throw new ConfigError('ai.mode', 'live or demo');
  const seenBoards = new Set<string>();
  const boards = (c.boards === undefined ? [] : Array.isArray(c.boards) ? c.boards : [c.boards])
    .map((board, i) => parseBoard(board, `boards[${i}]`, seenBoards));
  if (boards.filter(board => board.default).length > 1) throw new ConfigError('boards', 'only one board can be the default');
  const seenRepos = new Set<string>();
  const repositories = (c.repositories === undefined ? [] : Array.isArray(c.repositories) ? c.repositories : [c.repositories])
    .map((repo, i) => parseRepository(repo, `repositories[${i}]`, seenRepos));
  let chat: ChatConnection | undefined;
  if (c.chat !== undefined) {
    const raw = object(c.chat, 'chat');
    if (raw.provider !== 'slack') throw new ConfigError('chat.provider', `unknown chat provider ${JSON.stringify(raw.provider)} (slack)`);
    chat = { id: connectionId(raw.id ?? 'slack', 'chat.id', new Set()), provider: 'slack', botToken: text(raw.botToken, 'chat.botToken'),
      ...(raw.userToken !== undefined ? { userToken: text(raw.userToken, 'chat.userToken') } : {}) };
  }
  let people: IdentityRecord[] = [];
  if (c.people !== undefined) {
    try { people = parseIdentityRecords(JSON.stringify(c.people)); }
    catch (error) { throw new ConfigError('people', error instanceof Error ? error.message : 'invalid'); }
  }
  return {
    tenant: { id: tenantId, name: text(tenant.name, 'tenant.name', true) || tenantId,
      ...teamCalendar(tenant.timeZone, tenant.weekStartsOn, 'tenant.timeZone', 'tenant.weekStartsOn') },
    ai: {
      mode: ai.mode === 'live' ? 'live' : 'demo',
      ...(ai.anthropicApiKey !== undefined ? { anthropicApiKey: text(ai.anthropicApiKey, 'ai.anthropicApiKey') } : {}),
      ...(ai.model !== undefined ? { model: text(ai.model, 'ai.model') } : {}),
      ...(ai.agentModel !== undefined ? { agentModel: text(ai.agentModel, 'ai.agentModel') } : {}),
      ...(ai.codeReasoningModel !== undefined ? { codeReasoningModel: text(ai.codeReasoningModel, 'ai.codeReasoningModel') } : {}),
      agent: ai.agent !== false,
      agentThinking: ai.agentThinking === true,
      maxCodeReasoningCallsPerSession: typeof ai.maxCodeReasoningCallsPerSession === 'number' ? ai.maxCodeReasoningCallsPerSession : 3,
      prices: { input: price('input'), output: price('output'), agentInput: price('agentInput'), agentOutput: price('agentOutput'),
        codeInput: price('codeInput'), codeOutput: price('codeOutput') },
    },
    boards, repositories, ...(chat ? { chat } : {}), people,
    authorizedActorIds: texts(c.authorizedActorIds, 'authorizedActorIds'),
  };
}

/**
 * NOGITA_TENANT_CONFIG when set, else the environment. It is a file path, or the JSON itself (how the control plane
 * hands a cell its configuration, as one environment variable).
 */
export function loadTenantConfig(env: NodeJS.ProcessEnv): TenantConfig {
  const file = env.NOGITA_TENANT_CONFIG?.trim();
  if (!file) return tenantConfigFromEnv(env);
  if (file.startsWith('{')) return parseTenantConfig(file, env);
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { throw new ConfigError('', `cannot read ${file}`); }
  return parseTenantConfig(raw, env);
}
