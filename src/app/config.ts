import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardPort, BrainPort, ChatPort, CodePort, PolicyPort } from '../core/contracts.ts';
import type { ChatModel } from '../core/agent.ts';
import { SlackWorkspace } from '../adapters/slack-workspace.ts';
import { AllowlistPolicy } from '../core/policy.ts';
import { IdentityDirectory, parseIdentityRecords } from '../core/identity.ts';
import { DemoBoard, DemoBrain, DemoCode } from '../adapters/demo.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../adapters/anthropic.ts';
import { JiraBoard } from '../adapters/jira.ts';
import { MondayBoard } from '../adapters/monday.ts';
import { GitHubCode } from '../adapters/github.ts';

export function loadDotEnv(): void {
  const filename = resolve(process.cwd(), '.env');
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w]*)=(.*)$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!;
  }
}
export function createDependencies(env: NodeJS.ProcessEnv = process.env): { board: BoardPort; code: CodePort; brain: BrainPort; policy: PolicyPort; identities: IdentityDirectory; agent?: ChatModel; chat?: ChatPort; people: IdentityDirectory } {
  const identities = new IdentityDirectory(env.IDENTITY_MAP_JSON ? parseIdentityRecords(env.IDENTITY_MAP_JSON) : []);
  const board: BoardPort = env.BOARD_PROVIDER === 'jira'
    ? new JiraBoard({ baseUrl: env.JIRA_BASE_URL ?? '', email: env.JIRA_EMAIL ?? '',
        token: env.JIRA_API_TOKEN ?? '', projectKey: env.JIRA_PROJECT_KEY ?? '',
        issueType: env.JIRA_ISSUE_TYPE ?? 'Task',
        allowedAssigneeIds: new Set((env.JIRA_ASSIGNEE_ACCOUNT_ID ?? '').split(',').filter(Boolean)),
        resolveAssigneeId: id => identities.jiraAccountIdFor(id),
        readProjectKeys: (env.JIRA_READ_PROJECT_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean) })
    : env.BOARD_PROVIDER === 'monday'
    ? new MondayBoard(env.MONDAY_API_TOKEN ?? '', Number(env.MONDAY_BOARD_ID ?? NaN), env.MONDAY_DESCRIPTION_COLUMN_ID ?? '')
    : new DemoBoard();
  const code: CodePort = env.REPO_PROVIDER === 'github'
    ? new GitHubCode({ token: env.GITHUB_TOKEN ?? '', publicRepo: env.GITHUB_PUBLIC_REPO === 'true', owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '', ref: env.GITHUB_REF ?? 'main' })
    : new DemoCode();
  const brain: BrainPort = env.NOGITA_MODE === 'live'
    ? new AnthropicBrain(env.ANTHROPIC_API_KEY ?? '', env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL, fetch, {
        inputUsdPerMillion: Number(env.ANTHROPIC_INPUT_USD_PER_MILLION ?? '0.10'),
        outputUsdPerMillion: Number(env.ANTHROPIC_OUTPUT_USD_PER_MILLION ?? '0.50'),
      }, {
        codeReasoningModel: env.ANTHROPIC_CODE_REASONING_MODEL,
        inputUsdPerMillion: Number(env.ANTHROPIC_CODE_INPUT_USD_PER_MILLION ?? '3'),
        outputUsdPerMillion: Number(env.ANTHROPIC_CODE_OUTPUT_USD_PER_MILLION ?? '15'),
        maxCodeReasoningCallsPerSession: Number(env.ANTHROPIC_MAX_CODE_REASONING_CALLS_PER_SESSION ?? '3'),
      }, {
        model: env.ANTHROPIC_AGENT_MODEL,
        inputUsdPerMillion: Number(env.ANTHROPIC_AGENT_INPUT_USD_PER_MILLION ?? '0.10'),
        outputUsdPerMillion: Number(env.ANTHROPIC_AGENT_OUTPUT_USD_PER_MILLION ?? '0.50'),
        thinking: env.ANTHROPIC_AGENT_THINKING === 'off' ? 'off' : 'default',
      })
    : new DemoBrain();
  // The tool-using agent answers direct requests in live mode; NOGITA_AGENT=off keeps the one-shot planner.
  const agent = brain instanceof AnthropicBrain && env.NOGITA_AGENT !== 'off' ? brain : undefined;
  const chat = env.SLACK_BOT_TOKEN?.startsWith('xoxb-')
    ? new SlackWorkspace(env.SLACK_BOT_TOKEN, env.SLACK_USER_TOKEN?.startsWith('xoxp-') ? env.SLACK_USER_TOKEN : undefined)
    : undefined;
  const authorized = new Set((env.AUTHORIZED_ACTOR_IDS ?? 'demo-lead').split(',').map(s => s.trim()).filter(Boolean));
  return { board, code, brain, policy: new AllowlistPolicy(authorized), identities, agent, chat, people: identities };
}
