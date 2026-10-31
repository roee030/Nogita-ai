import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgent, type AgentToolbox, type ChatModel } from '../../src/core/agent.ts';
import { agentUserMessage, stableAgentPrompt, turnAgentPrompt } from '../../src/core/agent-prompt.ts';
import { teamPeriod, UTC_TEAM, type TeamTime } from '../../src/core/team-time.ts';

const execFileAsync = promisify(execFile);

export type ResearchPeriod = 'today' | 'this_week';

export interface ResearchGroundTruth {
  branch: string;
  since: string;
  until: string;
  commits: Array<{ sha: string; title: string }>;
  pullRequests: number[];
}

export interface ResearchCoverage {
  passed: boolean;
  foundCommits: string[];
  missingCommits: string[];
  foundPullRequests: number[];
  missingPullRequests: number[];
}

export interface ResearchScenarioResult {
  period: ResearchPeriod;
  answer: string;
  ms: number;
  steps: number;
  toolCalls: string[];
  coverage: ResearchCoverage;
}

export function parseGitLog(output: string, range: Pick<ResearchGroundTruth, 'branch' | 'since' | 'until'>): ResearchGroundTruth {
  const commits = output.split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf('\u001f');
    if (separator < 0) throw new Error('git log returned a line without the expected field separator');
    return { sha: line.slice(0, separator), title: line.slice(separator + 1) };
  });
  const pullRequests = [...new Set(commits.flatMap(commit => {
    const numbers: number[] = [];
    const pattern = /(?:merge pull request\s+|\bPR\s*)?#(\d+)/gi;
    for (let match = pattern.exec(commit.title); match; match = pattern.exec(commit.title)) numbers.push(Number(match[1]));
    return numbers;
  }))].sort((a, b) => a - b);
  return { ...range, commits, pullRequests };
}

export function scoreCoverage(answer: string, truth: ResearchGroundTruth): ResearchCoverage {
  const foundCommits = truth.commits.map(commit => commit.sha.slice(0, 7)).filter(sha => answer.toLowerCase().includes(sha.toLowerCase()));
  const missingCommits = truth.commits.map(commit => commit.sha.slice(0, 7)).filter(sha => !foundCommits.includes(sha));
  const foundPullRequests = truth.pullRequests.filter(number => new RegExp(`(?:#|PR\\s*#?)[ \\t]*${number}(?!\\d)`, 'i').test(answer));
  const missingPullRequests = truth.pullRequests.filter(number => !foundPullRequests.includes(number));
  return { passed: missingCommits.length === 0 && missingPullRequests.length === 0,
    foundCommits, missingCommits, foundPullRequests, missingPullRequests };
}

export async function readGitGroundTruth(period: ResearchPeriod, options: {
  branch: string;
  now?: number;
  team?: TeamTime;
  git?: (args: string[]) => Promise<string>;
}): Promise<ResearchGroundTruth> {
  const now = options.now ?? Date.now();
  const range = teamPeriod(period, now, options.team ?? UTC_TEAM);
  const args = ['log', options.branch, `--since=${range.since}`, `--until=${range.until}`, '--format=%H%x1f%s', '--no-decorate'];
  const git = options.git ?? (async command => (await execFileAsync('git', command, { encoding: 'utf8' })).stdout);
  const output = await git(args);
  return parseGitLog(output, { branch: options.branch, since: range.since, until: range.until });
}

export function formatResearchReport(result: ResearchScenarioResult, truth: ResearchGroundTruth): string {
  const coverage = result.coverage;
  const lines = [
    `${coverage.passed ? 'PASS' : 'FAIL'} ${result.period} ${(result.ms / 1_000).toFixed(2)} s; ` +
      `commits ${coverage.foundCommits.length}/${truth.commits.length}; PRs ${coverage.foundPullRequests.length}/${truth.pullRequests.length}; ` +
      `steps ${result.steps}; tools ${result.toolCalls.join(', ') || 'none'}`,
  ];
  if (coverage.missingCommits.length) lines.push(`  missing commits: ${coverage.missingCommits.join(', ')}`);
  if (coverage.missingPullRequests.length) lines.push(`  missing PRs: ${coverage.missingPullRequests.map(number => `#${number}`).join(', ')}`);
  lines.push(`  answer: ${result.answer.replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

export async function runResearchScenario(input: {
  period: ResearchPeriod;
  groundTruth: ResearchGroundTruth;
  model: ChatModel;
  toolbox: AgentToolbox;
  now?: () => number;
  nowIso?: string;
  team?: TeamTime;
}): Promise<ResearchScenarioResult> {
  const clock = input.now ?? Date.now;
  const started = clock();
  const periodWords = input.period === 'today' ? 'today' : 'this week';
  const request = `Nogita, what landed in the repository ${periodWords}? Include every commit with its short SHA and every merged pull request with its PR number.`;
  const result = await runAgent(input.model, {
    stableSystem: stableAgentPrompt({ voice: false }),
    turnSystem: turnAgentPrompt({ speaker: 'Research benchmark', authorized: true,
      nowIso: input.nowIso ?? new Date().toISOString(), team: input.team, followUp: false }),
    messages: [{ role: 'user', content: agentUserMessage([], 'Research benchmark', request) }],
    toolbox: input.toolbox,
    stream: false,
    request,
    now: clock,
    deadlineMs: 90_000,
    maxTokens: 1_500,
    toolStepMaxTokens: 4_000,
    maxSteps: 8,
  });
  return { period: input.period, answer: result.answer, ms: Math.max(0, clock() - started), steps: result.steps,
    toolCalls: result.toolCalls, coverage: scoreCoverage(result.answer, input.groundTruth) };
}
