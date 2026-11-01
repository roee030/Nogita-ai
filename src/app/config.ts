import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardPort, BrainPort, ChatPort, CodePort, PolicyPort, PullRequestPort } from '../core/contracts.ts';
import type { ChatModel } from '../core/agent.ts';
import type { ResearchFeatures } from '../core/engine.ts';
import { SlackWorkspace } from '../adapters/slack-workspace.ts';
import { AllowlistPolicy } from '../core/policy.ts';
import { IdentityDirectory } from '../core/identity.ts';
import { guardPort, type ProviderHealth } from '../core/provider-health.ts';
import { DemoBoard, DemoBrain, DemoCode } from '../adapters/demo.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../adapters/anthropic.ts';
import { JiraBoard } from '../adapters/jira.ts';
import { MondayBoard } from '../adapters/monday.ts';
import { GitHubCode } from '../adapters/github.ts';
import { GitHubDrafts } from '../adapters/github-drafts.ts';
import { MultiBoard, MultiCode } from '../adapters/multi.ts';
import { BROKER_PREFIX, BrokerClient, type TokenSource } from '../adapters/token-source.ts';
import { loadTenantConfig, type BoardConnection, type RepositoryConnection, type TenantConfig } from './tenant-config.ts';

export function loadDotEnv(name = '.env'): void {
  const filename = resolve(process.cwd(), name);
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w]*)=(.*)$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!;
  }
}
const RESEARCH_FLAGS = { ciStatus: 'NOGITA_CI_STATUS', resultDigest: 'NOGITA_RESULT_DIGEST',
  evidenceLedger: 'NOGITA_EVIDENCE_LEDGER', proofLevels: 'NOGITA_PROOF_LEVELS', researchTemplates: 'NOGITA_RESEARCH_TEMPLATES' } as const;

/** Phase 3 research features from the environment: each 'true' turns one on; blank or 'false' leaves it off. */
export function researchFeatures(env: NodeJS.ProcessEnv = process.env): ResearchFeatures {
  const features: ResearchFeatures = {};
  for (const [feature, name] of Object.entries(RESEARCH_FLAGS) as Array<[keyof ResearchFeatures, string]>) {
    const value = env[name]?.trim() ?? '';
    if (!['', 'true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
    if (value === 'true') features[feature] = true;
  }
  return features;
}

/** NOGITA_ROOM_NOISE_GUARD: 'true' keeps room noise and side talk from getting a spoken reply; blank or 'false' leaves it off. */
export function roomNoiseGuard(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_ROOM_NOISE_GUARD?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_ROOM_NOISE_GUARD must be true or false');
  return value === 'true';
}

/** NOGITA_SWALLOWED_QUESTION: 'true' has her ask at once when a question to her was lost; blank or 'false' leaves it off. */
export function swallowedQuestion(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_SWALLOWED_QUESTION?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_SWALLOWED_QUESTION must be true or false');
  return value === 'true';
}

/** NOGITA_TWO_SPEED: 'true' answers a spoken research question in two speeds (a short line now, the full answer from a
 *  background mission); blank or 'false' leaves it off. */
export function twoSpeed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_TWO_SPEED?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_TWO_SPEED must be true or false');
  return value === 'true';
}

/** NOGITA_MISSION_STATUS: 'true' offers mission_status ("what's left of what I asked?"); blank or 'false' leaves it off. */
export function missionStatus(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_MISSION_STATUS?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_MISSION_STATUS must be true or false');
  return value === 'true';
}

/** NOGITA_PENDING_APPROVALS: 'true' tells each turn which writes the speaker's missions wait on, so "approve it" works after a
 *  restart or in a new chat thread; blank or 'false' leaves it off. */
export function pendingApprovals(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_PENDING_APPROVALS?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_PENDING_APPROVALS must be true or false');
  return value === 'true';
}

/** NOGITA_WHATS_LEFT_DIRECT: 'true' lets mission_status answer for requests done in the turn itself, not only missions;
 *  blank or 'false' leaves it off. */
export function whatsLeftDirect(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_WHATS_LEFT_DIRECT?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_WHATS_LEFT_DIRECT must be true or false');
  return value === 'true';
}

/** NOGITA_SHORT_SPOKEN_RESULTS: 'true' speaks a mission's result and a mission_status answer in a sentence or two and
 *  puts the full text in chat; blank or 'false' leaves it off. */
export function shortSpokenResults(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_SHORT_SPOKEN_RESULTS?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_SHORT_SPOKEN_RESULTS must be true or false');
  return value === 'true';
}

/** NOGITA_TASK_FROM_TOPIC: 'true' creates a task whose topic was said at once, instead of asking what it should say; blank or
 *  'false' leaves it off. */
export function taskFromTopic(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_TASK_FROM_TOPIC?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_TASK_FROM_TOPIC must be true or false');
  return value === 'true';
}

/** NOGITA_NOISY_TASK_REQUESTS: 'true' lets a task request through fillers, a misheard task noun ("tusks") and Hebrew; blank or
 *  'false' leaves it off. */
export function noisyTaskRequests(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_NOISY_TASK_REQUESTS?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_NOISY_TASK_REQUESTS must be true or false');
  return value === 'true';
}

/** NOGITA_PROVIDER_BREAKER: 'true' puts a circuit breaker on each provider (Jira, GitHub, Slack, Anthropic, Deepgram), so an
 *  outage gets one short line instead of retries and timeouts; blank or 'false' leaves it off. */
export function providerBreakers(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOGITA_PROVIDER_BREAKER?.trim() ?? '';
  if (!['', 'true', 'false'].includes(value)) throw new Error('NOGITA_PROVIDER_BREAKER must be true or false');
  return value === 'true';
}

/** The providers' calls through their breakers: the board, the repository and draft PRs, chat, and the model. */
export function guardProviders(deps: Dependencies, health: ProviderHealth): Dependencies {
  const boardName = deps.connections.boards[0] === 'monday' ? 'Monday' : deps.board.name || 'Jira';
  const github = health.breaker('github', 'GitHub');
  const anthropic = health.breaker('anthropic', 'my AI service');
  // The agent is the same Anthropic client as the brain (streamChat is its agent call): one breaker and one proxy for both.
  const brain = guardPort(deps.brain as BrainPort & Partial<ChatModel>, anthropic,
    ['plan', 'answerWithEvidence', 'suggestContribution', 'assessContribution', 'streamChat']);
  return { ...deps,
    board: guardPort(deps.board, health.breaker('jira', boardName), ['createTask', 'updateTask', 'searchTasks', 'getTask', 'findAssignees']),
    code: guardPort(deps.code, github, ['findEvidence', 'readFile', 'listFiles', 'recentCommits', 'overview', 'repoActivity', 'getChange', 'ciStatus']),
    brain,
    ...(deps.agent ? { agent: Object.is(deps.agent, deps.brain) ? brain as ChatModel : guardPort(deps.agent, anthropic, ['streamChat']) } : {}),
    ...(deps.chat ? { chat: guardPort(deps.chat, health.breaker('slack', 'Slack'), ['listChannels', 'readChannel', 'searchMessages', 'readThread', 'postMessage']) } : {}),
    ...(deps.drafts ? { drafts: guardPort(deps.drafts, github, ['openDraft']) } : {}),
  };
}

/** Every research feature on, for `npm run eval -- --research` and `npm run voice-lab -- --research`. */
export const ALL_RESEARCH_FEATURES: Required<ResearchFeatures> = { ciStatus: true, resultDigest: true, evidenceLedger: true,
  proofLevels: true, researchTemplates: true };

export type Dependencies = { tenant: TenantConfig['tenant'];
  /** Which providers are connected and who may act: no secrets, for readiness. */
  connections: { boards: string[]; repositories: string[]; authorizedActorIds: string[] }; board: BoardPort; code: CodePort; brain: BrainPort; policy: PolicyPort;
  identities: IdentityDirectory; agent?: ChatModel; chat?: ChatPort; people: IdentityDirectory; drafts?: PullRequestPort };

/** The company's Nogita from NOGITA_TENANT_CONFIG, or from the environment as before. */
export function createDependencies(env: NodeJS.ProcessEnv = process.env): Dependencies {
  const broker = env.NOGITA_BROKER_URL?.trim() && env.NOGITA_CELL_TOKEN?.trim()
    ? new BrokerClient(env.NOGITA_BROKER_URL.trim(), env.NOGITA_CELL_TOKEN.trim()) : undefined;
  return buildDependencies(loadTenantConfig(env), broker);
}

/** A configured token, or a source that asks the control plane's broker for `"broker:<id>"`. */
function tokenFor(value: string, broker: BrokerClient | undefined): TokenSource {
  if (!value.startsWith(BROKER_PREFIX)) return value;
  if (!broker) throw new Error(`${value} needs NOGITA_BROKER_URL and NOGITA_CELL_TOKEN`);
  return broker.source(value.slice(BROKER_PREFIX.length));
}

function buildBoard(connection: BoardConnection, identities: IdentityDirectory, broker?: BrokerClient): BoardPort {
  switch (connection.provider) {
    case 'jira': return new JiraBoard({ baseUrl: connection.baseUrl, email: connection.email, cloudId: connection.cloudId,
      token: tokenFor(connection.token, broker),
      projectKey: connection.projectKey, issueType: connection.issueType ?? 'Task',
      allowedAssigneeIds: new Set(connection.assigneeAccountIds ?? []),
      resolveAssigneeId: id => identities.accountFor(id, connection.id, 'jira'),
      resolveAssigneeEmail: id => identities.emailFor(id), readProjectKeys: connection.readProjectKeys ?? [] });
    case 'monday': return new MondayBoard(connection.token, connection.boardId, connection.descriptionColumnId);
    case 'demo': return new DemoBoard();
  }
}

function buildCode(connection: RepositoryConnection, broker?: BrokerClient): CodePort {
  switch (connection.provider) {
    case 'github': return new GitHubCode({ token: connection.token ? tokenFor(connection.token, broker) : '', publicRepo: connection.publicRepo === true,
      owner: connection.owner, repo: connection.repo, ref: connection.ref ?? 'main' });
    case 'demo': return new DemoCode();
  }
}

export function buildDependencies(config: TenantConfig, broker?: BrokerClient): Dependencies {
  const identities = new IdentityDirectory(config.people);
  const boards = config.boards.map(connection => ({ id: connection.id, board: buildBoard(connection, identities, broker) }));
  const board: BoardPort = boards.length === 0 ? new DemoBoard() : boards.length === 1 ? boards[0]!.board
    : new MultiBoard(boards, config.boards.find(connection => connection.default)?.id);
  const repos = config.repositories.map(connection => ({ id: connection.id, code: buildCode(connection, broker) }));
  const code: CodePort = repos.length === 0 ? new DemoCode() : repos.length === 1 ? repos[0]!.code : new MultiCode(repos);
  // Draft PRs go to the one repository that turned them on with a token that can write; several would need a choice.
  const draftRepos = config.repositories.filter(c => c.provider === 'github' && c.draftPullRequests === true && c.token);
  if (draftRepos.length > 1) throw new Error('Draft pull requests can be turned on for one repository only');
  const draftRepo = draftRepos[0];
  const drafts = draftRepo?.provider === 'github' ? new GitHubDrafts({ token: tokenFor(draftRepo.token!, broker),
    owner: draftRepo.owner, repo: draftRepo.repo, ref: draftRepo.ref ?? 'main' }) : undefined;
  const { ai } = config;
  const brain: BrainPort = ai.mode === 'live'
    ? new AnthropicBrain(ai.anthropicApiKey ?? '', ai.model ?? DEFAULT_ANTHROPIC_MODEL, fetch, {
        inputUsdPerMillion: ai.prices.input, outputUsdPerMillion: ai.prices.output,
      }, {
        codeReasoningModel: ai.codeReasoningModel,
        inputUsdPerMillion: ai.prices.codeInput, outputUsdPerMillion: ai.prices.codeOutput,
        maxCodeReasoningCallsPerSession: ai.maxCodeReasoningCallsPerSession,
      }, {
        model: ai.agentModel,
        inputUsdPerMillion: ai.prices.agentInput, outputUsdPerMillion: ai.prices.agentOutput,
        thinking: ai.agentThinking ? 'default' : 'off',
      })
    : new DemoBrain();
  // The tool-using agent answers direct requests in live mode; agent off keeps the one-shot planner.
  const agent = brain instanceof AnthropicBrain && ai.agent ? brain : undefined;
  const chat = config.chat ? new SlackWorkspace(config.chat.botToken, config.chat.userToken) : undefined;
  const connections = { boards: config.boards.map(c => c.provider), repositories: config.repositories.map(c => c.provider),
    authorizedActorIds: config.authorizedActorIds };
  return { tenant: config.tenant, connections, board, code, brain, identities, agent, chat, people: identities, drafts,
    policy: new AllowlistPolicy(new Set(config.authorizedActorIds), { draftPullRequests: drafts !== undefined }) };
}
