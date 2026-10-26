import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardPort, BrainPort, CodePort, PolicyPort } from '../core/contracts.ts';
import { AllowlistPolicy } from '../core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode } from '../adapters/demo.ts';
import { AnthropicBrain } from '../adapters/anthropic.ts';
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
export function createDependencies(): { board: BoardPort; code: CodePort; brain: BrainPort; policy: PolicyPort } {
  const env = process.env;
  const board: BoardPort = env.BOARD_PROVIDER === 'jira'
    ? new JiraBoard({ baseUrl: env.JIRA_BASE_URL ?? '', email: env.JIRA_EMAIL ?? '',
        token: env.JIRA_API_TOKEN ?? '', projectKey: env.JIRA_PROJECT_KEY ?? '',
        issueType: env.JIRA_ISSUE_TYPE ?? 'Task',
        allowedAssigneeIds: new Set((env.JIRA_ASSIGNEE_ACCOUNT_ID ?? '').split(',').filter(Boolean)) })
    : env.BOARD_PROVIDER === 'monday'
    ? new MondayBoard(env.MONDAY_API_TOKEN ?? '', Number(env.MONDAY_BOARD_ID ?? NaN), env.MONDAY_DESCRIPTION_COLUMN_ID ?? '')
    : new DemoBoard();
  const code: CodePort = env.REPO_PROVIDER === 'github'
    ? new GitHubCode({ token: env.GITHUB_TOKEN ?? '', owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '', ref: env.GITHUB_REF ?? 'main' })
    : new DemoCode();
  const brain: BrainPort = env.NOGITA_MODE === 'live'
    ? new AnthropicBrain(env.ANTHROPIC_API_KEY ?? '', env.ANTHROPIC_MODEL ?? '')
    : new DemoBrain();
  const authorized = new Set((env.AUTHORIZED_ACTOR_IDS ?? 'demo-lead').split(',').map(s => s.trim()).filter(Boolean));
  return { board, code, brain, policy: new AllowlistPolicy(authorized) };
}
