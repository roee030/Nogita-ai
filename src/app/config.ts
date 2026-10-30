import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardPort, BrainPort, ChatPort, CodePort, PolicyPort } from '../core/contracts.ts';
import type { ChatModel } from '../core/agent.ts';
import { SlackWorkspace } from '../adapters/slack-workspace.ts';
import { AllowlistPolicy } from '../core/policy.ts';
import { IdentityDirectory } from '../core/identity.ts';
import { DemoBoard, DemoBrain, DemoCode } from '../adapters/demo.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../adapters/anthropic.ts';
import { JiraBoard } from '../adapters/jira.ts';
import { MondayBoard } from '../adapters/monday.ts';
import { GitHubCode } from '../adapters/github.ts';
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
export type Dependencies = { tenant: TenantConfig['tenant'];
  /** Which providers are connected and who may act: no secrets, for readiness. */
  connections: { boards: string[]; repositories: string[]; authorizedActorIds: string[] }; board: BoardPort; code: CodePort; brain: BrainPort; policy: PolicyPort;
  identities: IdentityDirectory; agent?: ChatModel; chat?: ChatPort; people: IdentityDirectory };

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
  return { tenant: config.tenant, connections, board, code, brain, policy: new AllowlistPolicy(new Set(config.authorizedActorIds)), identities,
    agent, chat, people: identities };
}
