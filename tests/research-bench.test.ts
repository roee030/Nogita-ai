import test from 'node:test';
import assert from 'node:assert/strict';
import { assertActivityMatchesTruth, assertRepositoryMatches, formatResearchReport, gitRefToBranch, parseGitLog,
  readGitGroundTruth, scoreCoverage, runResearchScenario,
  type ResearchGroundTruth, type ResearchScenarioResult } from '../tools/research-bench/index.ts';
import type { AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

class ScriptedModel implements ChatModel {
  readonly agentModel = 'research-test';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly responses: ChatModelResponse[]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected model call');
    for (const block of response.content) if (block.type === 'text') onText(block.text);
    return response;
  }
}

const truth: ResearchGroundTruth = {
  branch: 'origin/main', remoteUrl: 'https://github.com/acme/app.git',
  since: '2026-10-25T00:00:00.000Z', until: '2026-10-31T12:00:00.000Z',
  commits: [
    { sha: '1234567890abcdef1234567890abcdef12345678', title: 'P3-1: add CI status (#34)' },
    { sha: 'abcdef0123456789abcdef0123456789abcdef01', title: 'Merge pull request #35 from team/p3-2' },
  ],
  pullRequests: [34, 35],
};

test('git log parsing keeps every commit and finds squash and merge pull request numbers', () => {
  const parsed = parseGitLog([
    '1234567890abcdef1234567890abcdef12345678\u001fP3-1: add CI status (#34)',
    'abcdef0123456789abcdef0123456789abcdef01\u001fMerge pull request #35 from team/p3-2',
    'fedcba9876543210fedcba9876543210fedcba98\u001fplain commit',
    '',
  ].join('\n'), { branch: 'origin/main', since: truth.since, until: truth.until });

  assert.deepEqual(parsed.commits.map(commit => commit.sha.slice(0, 7)), ['1234567', 'abcdef0', 'fedcba9']);
  assert.deepEqual(parsed.pullRequests, [34, 35]);
});

test('git log PR inference ignores issue references that are not merge or squash subjects', () => {
  const parsed = parseGitLog([
    '1234567890abcdef1234567890abcdef12345678\u001fFix parser; refs #123',
    'abcdef0123456789abcdef0123456789abcdef01\u001fAdd retries (#34)',
  ].join('\n'), { branch: 'origin/main', since: truth.since, until: truth.until });
  assert.deepEqual(parsed.pullRequests, [34]);
});

test('local git refs map to the live GitHub branch and repository mismatches stop the gate', () => {
  assert.equal(gitRefToBranch('origin/main'), 'main');
  assert.equal(gitRefToBranch('origin/feature/research-gate'), 'feature/research-gate');
  assert.equal(gitRefToBranch('refs/remotes/origin/release'), 'release');
  assert.throws(() => gitRefToBranch('refs/remotes/upstream/release'), /origin/);
  assert.doesNotThrow(() => assertRepositoryMatches('https://github.com/acme/app.git', 'acme/app', 'main', 'main'));
  assert.throws(() => assertRepositoryMatches('git@github.com:acme/other.git', 'acme/app', 'main', 'main'), /different repository/);
  assert.throws(() => assertRepositoryMatches('https://github.com/acme/app.git', 'acme/app', 'release', 'main'), /different branch/);
});

test('live GitHub activity must contain exactly the commits and PRs used as git ground truth', () => {
  const activity = { repository: 'acme/app', branch: 'main', since: truth.since, until: truth.until,
    commits: truth.commits.map(commit => ({ ...commit, url: '', author: '', date: '' })),
    mergedPullRequests: truth.pullRequests.map(number => ({ number, url: '', title: '', body: '', author: '', mergedAt: '' })),
    truncated: false };
  assert.doesNotThrow(() => assertActivityMatchesTruth(activity, truth));
  assert.throws(() => assertActivityMatchesTruth({ ...activity, commits: activity.commits.slice(1) }, truth), /activity differs.*commit/i);
  assert.throws(() => assertActivityMatchesTruth({ ...activity, mergedPullRequests: [] }, truth), /activity differs.*PR/i);
  assert.throws(() => assertActivityMatchesTruth({ ...activity, truncated: true }, truth), /truncated/i);
});

test('coverage requires every short commit SHA and every PR number in the complete answer', () => {
  const complete = scoreCoverage('Landed: 1234567 in #34, then abcdef0 in PR #35.', truth);
  assert.equal(complete.passed, true);
  assert.deepEqual(complete.missingCommits, []);
  assert.deepEqual(complete.missingPullRequests, []);

  const partial = scoreCoverage('Only 1234567 and #34 landed.', truth);
  assert.equal(partial.passed, false);
  assert.deepEqual(partial.missingCommits, ['abcdef0']);
  assert.deepEqual(partial.missingPullRequests, [35]);
});

test('research scenario runs through the agent loop, times the complete answer and scores it against git', async () => {
  const model = new ScriptedModel([
    { stopReason: 'tool_use', content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'activity', name: 'repo_activity', input: { period: 'this_week', branch: 'main' } },
    ] },
    { stopReason: 'end_turn', content: [{ type: 'text', text: 'Landed 1234567 (#34) and abcdef0 (#35).' }] },
  ]);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const toolbox: AgentToolbox = {
    specs: [{ name: 'repo_activity', description: 'activity', input_schema: { type: 'object' } }],
    isWrite: () => false,
    run: async (name, input) => {
      calls.push({ name, input });
      return { content: '1234567 #34\nabcdef0 #35' };
    },
  };
  const ticks = [1_000, 1_020, 1_040, 1_080, 1_120];
  const result = await runResearchScenario({ period: 'this_week', groundTruth: truth, model, toolbox,
    branch: 'main', now: () => ticks.shift() ?? 1_120, nowIso: '2026-10-31T12:00:00.000Z' });

  assert.deepEqual(calls, [{ name: 'repo_activity', input: { period: 'this_week', branch: 'main' } }]);
  assert.equal(result.answer, 'Landed 1234567 (#34) and abcdef0 (#35).');
  assert.equal(result.coverage.passed, true);
  assert.ok(result.ms >= 0);
  assert.deepEqual(result.toolCalls, ['repo_activity']);
  assert.match(String(model.requests[0]!.messages[0]!.content), /branch main.*every commit.*short SHA.*every merged pull request.*PR number/i);
});

test('ground truth reads the requested live branch with team-calendar period bounds', async () => {
  const calls: string[][] = [];
  const result = await readGitGroundTruth('today', {
    branch: 'origin/main', now: Date.parse('2026-10-31T15:00:00Z'),
    team: { timeZone: 'Asia/Jerusalem', weekStartsOn: 'sunday' },
    git: async args => {
      calls.push(args);
      return args[0] === 'remote' ? 'https://github.com/acme/app.git\n'
        : '1234567890abcdef1234567890abcdef12345678\u001fP3-1 (#34)\n';
    },
  });

  assert.deepEqual(calls, [['remote', 'get-url', 'origin'], ['fetch', '--quiet', 'origin', 'main'], [
    'log', 'origin/main', '--since=2026-10-30T22:00:00.000Z', '--until=2026-10-31T15:00:00.000Z',
    '--format=%H%x1f%s', '--no-decorate',
  ]]);
  assert.equal(result.remoteUrl, 'https://github.com/acme/app.git');
  assert.equal(result.commits.length, 1);
  assert.deepEqual(result.pullRequests, [34]);
});

test('report makes elapsed time, totals and every missing reference visible', () => {
  const result: ResearchScenarioResult = {
    period: 'this_week', answer: 'Only 1234567 (#34).', ms: 1_234, steps: 2, toolCalls: ['repo_activity'],
    coverage: { passed: false, foundCommits: ['1234567'], missingCommits: ['abcdef0'],
      foundPullRequests: [34], missingPullRequests: [35] },
  };
  const report = formatResearchReport(result, truth);
  assert.match(report, /FAIL this_week.*1\.23 s/);
  assert.match(report, /commits 1\/2.*PRs 1\/2/);
  assert.match(report, /missing commits: abcdef0/);
  assert.match(report, /missing PRs: #35/);
});
