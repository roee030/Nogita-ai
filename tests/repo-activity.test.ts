import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCode } from '../src/adapters/github.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { turnAgentPrompt } from '../src/core/agent-prompt.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { teamPeriod } from '../src/core/team-time.ts';
import { tenantConfigFromEnv } from '../src/app/tenant-config.ts';
import type { CodeChange, CodePort, RepoActivity } from '../src/core/contracts.ts';

const sha = (c: string) => c.repeat(40);
// Saturday 31 October 2026, 17:00 in Jerusalem (UTC+2: Israel left summer time on Sunday the 25th at 02:00).
const NOW = Date.parse('2026-10-31T15:00:00Z');
const jerusalem = { timeZone: 'Asia/Jerusalem', weekStartsOn: 'sunday' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A GitHub API fake: answers by path prefix and records every request. */
function fakeGitHub(routes: Array<[RegExp, (url: URL) => Response]>): { http: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const http = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const route = routes.find(([pattern]) => pattern.test(url.pathname));
    return route ? route[1](url) : json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return { http, urls };
}

test('team periods are the team\'s local days, across the change from summer time', () => {
  assert.deepEqual(teamPeriod('today', NOW, jerusalem), { since: '2026-10-30T22:00:00.000Z', until: '2026-10-31T15:00:00.000Z' });
  assert.deepEqual(teamPeriod('yesterday', NOW, jerusalem), { since: '2026-10-29T22:00:00.000Z', until: '2026-10-30T22:00:00.000Z' });
  // The week began at midnight on Sunday the 25th, still summer time (UTC+3).
  assert.equal(teamPeriod('this_week', NOW, jerusalem).since, '2026-10-24T21:00:00.000Z');
  assert.deepEqual(teamPeriod('last_week', NOW, jerusalem), { since: '2026-10-17T21:00:00.000Z', until: '2026-10-24T21:00:00.000Z' });
  assert.equal(teamPeriod('this_week', NOW, { timeZone: 'UTC', weekStartsOn: 'monday' }).since, '2026-10-26T00:00:00.000Z');
  // Just after local midnight, "today" is the new local day even though UTC is still on the previous one.
  assert.equal(teamPeriod('today', Date.parse('2026-10-31T22:30:00Z'), jerusalem).since, '2026-10-31T22:00:00.000Z');
});

test('the turn prompt gives the team\'s local time and what "today" means', () => {
  const prompt = turnAgentPrompt({ speaker: 'Roee', authorized: true, nowIso: new Date(NOW).toISOString(), team: jerusalem, followUp: false });
  assert.match(prompt, /Current time: 2026-10-31T15:00:00\.000Z\./);
  assert.match(prompt, /time zone is Asia\/Jerusalem; it is Saturday,? 31 October 2026,? (?:at )?17:00 there/);
  assert.match(prompt, /weeks start on Sunday/);
  assert.match(turnAgentPrompt({ speaker: 'Roee', authorized: true, nowIso: new Date(NOW).toISOString(), followUp: false }), /time zone is UTC/);
});

test('the team calendar comes from the environment and a bad time zone stops startup', () => {
  assert.deepEqual(tenantConfigFromEnv({ TEAM_TIMEZONE: 'Asia/Jerusalem', TEAM_WEEK_START: 'sunday' }).tenant,
    { id: 'default', name: 'Default', timeZone: 'Asia/Jerusalem', weekStartsOn: 'sunday' });
  assert.deepEqual(tenantConfigFromEnv({}).tenant, { id: 'default', name: 'Default' });
  assert.throws(() => tenantConfigFromEnv({ TEAM_TIMEZONE: 'Israel/Tel_Aviv' }), /TEAM_TIMEZONE/);
  assert.throws(() => tenantConfigFromEnv({ TEAM_WEEK_START: 'friday' }), /TEAM_WEEK_START/);
});

test('repo_activity reads the live branch: every commit page, merges inside the range, and one files summary', async () => {
  const commitPage = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({
    sha: (from + i).toString(16).padStart(40, '0'),
    commit: { message: `change ${from + i}\n\nbody`, author: { name: 'Dana Cohen', date: '2026-10-31T09:00:00Z' } },
    author: (from + i) % 2 ? { login: 'dana' } : null,
    parents: [{ sha: sha('f') }],
  }));
  const { http, urls } = fakeGitHub([
    [/\/commits$/, url => json(url.searchParams.get('page') === '1' ? commitPage(1, 100) : commitPage(101, 20))],
    [/\/pulls$/, () => json([
      { number: 21, title: 'Retry worker', body: 'Adds retries.\napi_key = "abcdefabcdefabcdefabcdefabcdef"', user: { login: 'dana' },
        merged_at: '2026-10-31T10:00:00Z', updated_at: '2026-10-31T10:00:00Z' },
      { number: 20, title: 'Closed unmerged', user: { login: 'yossi' }, merged_at: null, updated_at: '2026-10-31T08:00:00Z' },
      { number: 19, title: 'Merged yesterday', user: { login: 'yossi' }, merged_at: '2026-10-30T12:00:00Z', updated_at: '2026-10-30T12:00:00Z' },
    ])],
    [/\/compare\//, () => json({ files: [
      { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { filename: 'src/retry.ts', status: 'added', additions: 80, deletions: 0 },
    ] })],
  ]);
  const git = new GitHubCode({ token: 't', owner: 'acme', repo: 'app', ref: 'main' }, http, { now: () => NOW });
  const activity = await git.repoActivity({ since: '2026-10-30T22:00:00Z' });

  const commitCalls = urls.filter(url => url.pathname.endsWith('/commits'));
  assert.equal(commitCalls.length, 2);
  assert.equal(commitCalls[0]!.searchParams.get('sha'), 'main', 'the branch name, not a pinned snapshot sha');
  assert.equal(commitCalls[0]!.searchParams.get('since'), '2026-10-30T22:00:00.000Z');
  assert.equal(commitCalls[0]!.searchParams.get('until'), '2026-10-31T15:00:00.000Z');
  assert.equal(activity.commits.length, 120);
  assert.equal(activity.commits[0]!.title, 'change 1');
  assert.equal(activity.commits[1]!.author, 'Dana Cohen', 'falls back to the git author name');
  assert.deepEqual(activity.mergedPullRequests.map(pull => pull.number), [21]);
  assert.doesNotMatch(activity.mergedPullRequests[0]!.body, /abcdefabcdef/, 'secrets in descriptions are redacted');
  assert.match(urls.find(url => url.pathname.includes('/compare/'))!.pathname, new RegExp(`/compare/${sha('f')}\\.\\.\\.${commitPage(1, 1)[0]!.sha}$`));
  assert.deepEqual(activity.files, { changed: 2, additions: 83, deletions: 1, top: [
    { path: 'src/retry.ts', status: 'added', additions: 80, deletions: 0 },
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }] });
  assert.equal(activity.truncated, false);
  await assert.rejects(git.repoActivity({ since: 'yesterday' }), /invalid time range/);
  await assert.rejects(git.repoActivity({ since: '2026-10-30T00:00:00Z', branch: 'main;rm' }), /invalid branch/);
});

test('get_change returns files with trimmed, redacted patches and never shows a credential file', async () => {
  const big = Array.from({ length: 200 }, (_, i) => `+line ${i} of a long change`).join('\n');
  const { http } = fakeGitHub([
    [/\/commits\/abc1234$/, () => json({ sha: sha('a'), commit: { message: 'Add retries\n\nWhy: flaky API', author: { name: 'Dana', date: '2026-10-31T09:00:00Z' } },
      author: { login: 'dana' }, stats: { additions: 300, deletions: 2 }, files: [
        { filename: 'src/retry.ts', status: 'added', additions: 10, deletions: 0, patch: '+const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";\n+export {};' },
        { filename: 'config/.env.production', status: 'modified', additions: 1, deletions: 1, patch: '-A=1\n+A=2' },
        ...Array.from({ length: 6 }, (_, i) => ({ filename: `src/big${i}.ts`, status: 'modified', additions: 200, deletions: 0, patch: big })),
        { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
      ] })],
    [/\/pulls\/7$/, () => json({ number: 7, title: 'Retry worker', body: 'Closes KAN-3', state: 'closed', user: { login: 'dana' },
      merged_at: '2026-10-31T10:00:00Z', additions: 5, deletions: 1 })],
    [/\/pulls\/7\/files$/, () => json([{ filename: 'src/retry.ts', status: 'added', additions: 5, deletions: 1, patch: '+x' }])],
  ]);
  const git = new GitHubCode({ token: 't', owner: 'acme', repo: 'app', ref: 'main' }, http);

  const commit = (await git.getChange({ sha: 'abc1234' }))!;
  assert.equal(commit.kind, 'commit');
  assert.equal(commit.title, 'Add retries');
  assert.equal(commit.body, 'Why: flaky API');
  assert.equal(commit.files.length, 9);
  const retry = commit.files.find(file => file.path === 'src/retry.ts')!;
  assert.match(retry.patch!, /\[REDACTED\]/);
  assert.doesNotMatch(retry.patch!, /ghp_/);
  assert.equal(commit.files.find(file => file.path === 'config/.env.production')!.patch, undefined);
  assert.equal(commit.files.find(file => file.path === 'logo.png')!.patch, undefined);
  const shown = commit.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);
  assert.ok(shown <= 12_000, `patches stay inside the budget (${shown})`);
  assert.ok(commit.files.some(file => file.path.startsWith('src/big') && !file.patch), 'later patches drop once the budget is spent');
  assert.equal(commit.truncated, true);

  const pull = (await git.getChange({ pr: 7 }))!;
  assert.deepEqual([pull.kind, pull.id, pull.state, pull.files.length, pull.truncated], ['pull_request', '#7', 'merged', 1, false]);
  assert.equal(await git.getChange({ pr: 8 }), undefined);
  await assert.rejects(git.getChange({ sha: 'not-a-sha' }), /invalid commit sha/);
});

/** A code port that records what the tools asked for. */
class RecordingCode extends DemoCode implements CodePort {
  readonly asked: Array<{ since: string; until?: string; branch?: string }> = [];
  async repoActivity(query: { since: string; until?: string; branch?: string }): Promise<RepoActivity> {
    this.asked.push(query);
    return { repository: 'acme/app', branch: query.branch ?? 'main', since: query.since, until: query.until ?? '', snapshot: sha('c'),
      commits: [{ sha: sha('1'), url: 'https://github.com/acme/app/commit/1', author: 'dana', date: '2026-10-31T09:00:00Z', title: 'Add retries' }],
      mergedPullRequests: [{ number: 21, url: 'https://github.com/acme/app/pull/21', title: 'Retry worker', body: 'Adds retries.', author: 'dana', mergedAt: '2026-10-31T10:00:00Z' }],
      files: { changed: 1, additions: 80, deletions: 0, top: [{ path: 'src/retry.ts', status: 'added', additions: 80, deletions: 0 }] },
      truncated: false };
  }
  async getChange(ref: { sha?: string; pr?: number }): Promise<CodeChange | undefined> {
    if (ref.pr !== 21) return undefined;
    return { kind: 'pull_request', id: '#21', url: 'https://github.com/acme/app/pull/21', title: 'Retry worker', body: '', author: 'dana',
      state: 'merged', additions: 80, deletions: 0, files: [{ path: 'src/retry.ts', status: 'added', additions: 80, deletions: 0, patch: '+retry' }],
      truncated: false };
  }
}

function toolboxFor(code: CodePort, actor = { id: 'lead', displayName: 'Lead', verified: true }) {
  return buildToolbox({ actor, request: 'what went in today?', sessionId: 's', eventId: 'e',
    policy: new AllowlistPolicy(new Set(['lead'])), code, board: new DemoBoard(), completed: new Map(),
    onReceipt: async () => {}, team: jerusalem, now: () => NOW });
}

test('repo_activity turns "today" into the team\'s day and reports the live branch and the snapshot', async () => {
  const code = new RecordingCode();
  const { toolbox, report } = toolboxFor(code);
  const today = await toolbox.run('repo_activity', { period: 'today' });
  assert.deepEqual(code.asked[0], { since: '2026-10-30T22:00:00.000Z', until: '2026-10-31T15:00:00.000Z', branch: undefined });
  assert.equal(today.isError, undefined);
  assert.match(today.content, /live branch main/);
  assert.match(today.content, /snapshot ccccccc/);
  assert.match(today.content, /#21 Retry worker \(dana, merged 2026-10-31T10:00:00Z\)/);
  assert.match(today.content, /1111111 Add retries/);
  assert.match(today.content, /src\/retry\.ts \(added, \+80 -0\)/);
  assert.equal(report.codeReferences[0]!.url, 'https://github.com/acme/app/pull/21');

  await toolbox.run('repo_activity', { since: '2026-10-01T00:00:00Z', branch: 'release' });
  assert.deepEqual(code.asked[1], { since: '2026-10-01T00:00:00Z', until: undefined, branch: 'release' });
  assert.equal((await toolbox.run('repo_activity', {})).isError, true);
  assert.equal((await toolbox.run('repo_activity', { since: 'last tuesday' })).isError, true);
});

test('get_change shows a pull request diff and refuses bad input', async () => {
  const { toolbox } = toolboxFor(new RecordingCode());
  const change = await toolbox.run('get_change', { pr: 21 });
  assert.match(change.content, /Pull request #21 \(merged\): Retry worker/);
  assert.match(change.content, /src\/retry\.ts \(added, \+80 -0\)\n\+retry/);
  assert.equal((await toolbox.run('get_change', { pr: 99 })).isError, true);
  assert.equal((await toolbox.run('get_change', { sha: 'zzz' })).isError, true);
  assert.equal((await toolbox.run('get_change', {})).isError, true);
});

test('the repository tools are only offered to people who may read code, and only when the provider has them', () => {
  const guest = toolboxFor(new RecordingCode(), { id: 'guest', displayName: 'Guest', verified: true }).toolbox;
  assert.ok(!guest.specs.some(spec => spec.name === 'repo_activity' || spec.name === 'get_change'));
  const demo = toolboxFor(new DemoCode()).toolbox;
  assert.ok(!demo.specs.some(spec => spec.name === 'repo_activity'));
  assert.ok(toolboxFor(new RecordingCode()).toolbox.specs.some(spec => spec.name === 'repo_activity'));
});
