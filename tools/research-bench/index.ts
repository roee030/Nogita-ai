import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgent, type AgentToolbox, type ChatModel } from '../../src/core/agent.ts';
import { agentUserMessage, stableAgentPrompt, turnAgentPrompt } from '../../src/core/agent-prompt.ts';
import type { RepoActivity } from '../../src/core/contracts.ts';
import { teamPeriod, UTC_TEAM, type TeamTime } from '../../src/core/team-time.ts';

const execFileAsync = promisify(execFile);

export type ResearchPeriod = 'today' | 'this_week';

export interface ResearchGroundTruth {
  branch: string;
  remoteUrl: string;
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
    const merge = commit.title.match(/^Merge pull request #(\d+)\b/i);
    const squash = commit.title.match(/\(#(\d+)\)$/);
    return [merge?.[1], squash?.[1]].filter((number): number is string => number !== undefined).map(Number);
  }))].sort((a, b) => a - b);
  return { ...range, remoteUrl: '', commits, pullRequests };
}

export function gitRefToBranch(ref: string): string {
  const match = ref.match(/^(?:refs\/remotes\/)?origin\/(.+)$/);
  if (!match?.[1]) throw new Error('The research benchmark branch must be an origin/<branch> ref');
  return match[1];
}

function githubRepository(remoteUrl: string): string | undefined {
  return remoteUrl.trim().match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1]?.replace(/\.git$/i, '').toLowerCase();
}

export function assertRepositoryMatches(remoteUrl: string, repository: string, expectedBranch: string, liveBranch: string): void {
  const local = githubRepository(remoteUrl);
  if (!local || local !== repository.toLowerCase()) {
    throw new Error(`Ground truth and agent use a different repository (${local ?? remoteUrl} versus ${repository})`);
  }
  if (expectedBranch !== liveBranch) {
    throw new Error(`Ground truth and agent use a different branch (${expectedBranch} versus ${liveBranch})`);
  }
}

export function assertActivityMatchesTruth(activity: RepoActivity, truth: ResearchGroundTruth): void {
  if (activity.truncated) throw new Error('Live GitHub activity is truncated; the research gate cannot establish complete ground truth');
  const localCommits = new Set(truth.commits.map(commit => commit.sha.toLowerCase()));
  const liveCommits = new Set(activity.commits.map(commit => commit.sha.toLowerCase()));
  if (localCommits.size !== liveCommits.size || [...localCommits].some(sha => !liveCommits.has(sha))) {
    throw new Error('Live GitHub activity differs from local git ground truth for commits');
  }
  const localPulls = new Set(truth.pullRequests);
  const livePulls = new Set(activity.mergedPullRequests.map(pull => pull.number));
  if (localPulls.size !== livePulls.size || [...localPulls].some(number => !livePulls.has(number))) {
    throw new Error('Live GitHub activity differs from local git ground truth for PRs');
  }
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
  const remoteUrl = (await git(['remote', 'get-url', 'origin'])).trim();
  await git(['fetch', '--quiet', 'origin', gitRefToBranch(options.branch)]);
  const output = await git(args);
  return { ...parseGitLog(output, { branch: options.branch, since: range.since, until: range.until }), remoteUrl };
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
  branch?: string;
  model: ChatModel;
  toolbox: AgentToolbox;
  now?: () => number;
  nowIso?: string;
  team?: TeamTime;
}): Promise<ResearchScenarioResult> {
  const clock = input.now ?? Date.now;
  const started = clock();
  const periodWords = input.period === 'today' ? 'today' : 'this week';
  const branchWords = input.branch ? ` on branch ${input.branch}` : '';
  const request = `Nogita, what landed in the repository${branchWords} ${periodWords}? Include every commit with its short SHA and every merged pull request with its PR number.`;
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
