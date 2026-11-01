import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCode } from '../src/adapters/github.ts';
import { DemoBoard } from '../src/adapters/demo.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import type { CiStatus, CodePort } from '../src/core/contracts.ts';

const sha = (c: string) => c.repeat(40);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A GitHub API fake: answers by path and records every request. */
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

const github = (http: typeof fetch) => new GitHubCode({ token: 't', owner: 'acme', repo: 'app', ref: 'main' }, http);

const runs = [
  { id: 2, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: sha('b'), head_branch: 'main', event: 'push',
    html_url: 'https://github.com/acme/app/actions/runs/2', run_started_at: '2026-10-31T10:00:00Z',
    head_commit: { message: 'Fix the retry worker\n\nLonger body' } },
  { id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: sha('a'), head_branch: 'main', event: 'push',
    html_url: 'https://github.com/acme/app/actions/runs/1', run_started_at: '2026-10-31T09:00:00Z' },
];
const failingJobs = { jobs: [
  { name: 'test', conclusion: 'failure', html_url: 'https://github.com/acme/app/actions/runs/2/job/7',
    steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] },
  { name: 'typecheck', conclusion: 'success', html_url: 'https://github.com/acme/app/actions/runs/2/job/8', steps: [] },
] };

test('ci_status for a branch: newest runs, the failed job and step, the deployed commit and what is not deployed', async () => {
  const { http, urls } = fakeGitHub([
    [/\/actions\/runs\/2\/jobs$/, () => json(failingJobs)],
    [/\/actions\/runs$/, () => json({ workflow_runs: runs })],
    [/\/deployments\/11\/statuses$/, () => json([{ state: 'failure' }])],
    [/\/deployments\/10\/statuses$/, () => json([{ state: 'success', environment_url: 'https://app.example.com' }])],
    [/\/deployments$/, () => json([
      { id: 12, sha: sha('c'), environment: 'pr-5', created_at: '2026-10-31T11:00:00Z', transient_environment: true },
      { id: 11, sha: sha('b'), environment: 'production', created_at: '2026-10-31T10:05:00Z' },
      { id: 10, sha: sha('a'), environment: 'production', created_at: '2026-10-31T09:05:00Z' },
    ])],
    [/\/compare\//, () => json({ status: 'ahead', ahead_by: 2, commits: [
      { sha: sha('e'), commit: { message: 'Fix the retry worker\n\nLonger body' } }, { sha: sha('f'), commit: { message: 'Add the time zone' } }] })],
  ]);
  const ci = await github(http).ciStatus({});
  assert.ok(ci);
  assert.deepEqual(ci.target, { branch: 'main' });
  assert.equal(ci.runs.length, 2);
  assert.equal(ci.runs[0]!.conclusion, 'failure');
  assert.equal(ci.runs[0]!.title, 'Fix the retry worker');
  assert.equal(ci.runs[1]!.title, undefined);
  assert.deepEqual(ci.runs[0]!.failedJobs, [{ name: 'test', url: 'https://github.com/acme/app/actions/runs/2/job/7', step: 'npm test' }]);
  assert.equal(ci.runs[1]!.failedJobs, undefined, 'jobs are read only for failed runs');
  // The preview deployment is skipped and the failed one is passed over for the one that is running.
  assert.deepEqual(ci.deployment, { sha: sha('a'), environment: 'production', state: 'success', createdAt: '2026-10-31T09:05:00Z',
    url: 'https://app.example.com', notDeployed: 2,
    undeployed: [{ sha: sha('f'), title: 'Add the time zone' }, { sha: sha('e'), title: 'Fix the retry worker' }] });
  const listed = urls.find(url => url.pathname.endsWith('/actions/runs'))!;
  assert.equal(listed.searchParams.get('branch'), 'main');
  assert.ok(urls.some(url => url.pathname === `/repos/acme/app/compare/${sha('a')}...main`));
});

test('ci_status for a pull request reads the runs of its head commit; a short sha is resolved first', async () => {
  const { http, urls } = fakeGitHub([
    [/\/pulls\/5$/, () => json({ number: 5, head: { ref: 'feature/x', sha: sha('d') } })],
    [/\/commits\/abc1234$/, () => json({ sha: sha('e') })],
    [/\/actions\/runs$/, () => json({ workflow_runs: [] })],
    [/\/deployments$/, () => json([])],
  ]);
  const code = github(http);
  const pr = await code.ciStatus({ pr: 5 });
  assert.deepEqual(pr?.target, { pr: 5, branch: 'feature/x', sha: sha('d') });
  assert.deepEqual(pr?.runs, []);
  assert.equal(pr?.deployment, undefined);
  assert.equal(urls.filter(url => url.pathname.endsWith('/actions/runs')).at(-1)!.searchParams.get('head_sha'), sha('d'));
  const commit = await code.ciStatus({ sha: 'abc1234' });
  assert.deepEqual(commit?.target, { sha: sha('e') });
  assert.equal(urls.filter(url => url.pathname.endsWith('/actions/runs')).at(-1)!.searchParams.get('head_sha'), sha('e'));
  assert.equal(urls.some(url => url.pathname.includes('/compare/')), false, 'a commit target is not compared to a branch');
  assert.equal(await code.ciStatus({ pr: 99 }), undefined);
  await assert.rejects(code.ciStatus({ sha: 'xyz' }), /invalid commit sha/);
  await assert.rejects(code.ciStatus({ branch: 'main;rm' }), /invalid branch name/);
});

test('ci_status for a commit says whether the deployed commit contains it', async () => {
  const status = new Map([[sha('e'), 'behind'], [sha('f'), 'ahead'], [sha('c'), 'identical']]);
  const { http } = fakeGitHub([
    [/\/actions\/runs$/, () => json({ workflow_runs: [] })],
    [/\/deployments\/10\/statuses$/, () => json([{ state: 'success' }])],
    [/\/deployments$/, () => json([{ id: 10, sha: sha('c'), environment: 'production', created_at: '2026-10-31T09:05:00Z' }])],
    [/\/compare\//, url => json({ status: status.get(url.pathname.split('...')[1]!) ?? 'diverged' })],
  ]);
  const code = github(http);
  assert.equal((await code.ciStatus({ sha: sha('e') }))?.deployment?.includesTarget, true);
  assert.equal((await code.ciStatus({ sha: sha('c') }))?.deployment?.includesTarget, true);
  assert.equal((await code.ciStatus({ sha: sha('f') }))?.deployment?.includesTarget, false);
  assert.equal((await code.ciStatus({ sha: sha('d') }))?.deployment?.includesTarget, false, 'diverged is not deployed');
});

test('ci_status still answers when deployments or jobs cannot be read, without claiming no job failed', async () => {
  const { http } = fakeGitHub([
    [/\/actions\/runs\/2\/jobs$/, () => json({ message: 'Forbidden' }, 403)],
    [/\/actions\/runs$/, () => json({ workflow_runs: runs })],
    [/\/deployments$/, () => json({ message: 'Forbidden' }, 403)],
  ]);
  const ci = await github(http).ciStatus({ branch: 'main' });
  assert.equal(ci?.runs.length, 2);
  assert.equal(ci?.runs[0]!.failedJobs, undefined);
  assert.equal(ci?.deployment, undefined);
});

class FakeCi implements CodePort {
  readonly name = 'fake';
  readonly calls: Array<{ branch?: string; sha?: string; pr?: number }> = [];
  async findEvidence() { return []; }
  async ciStatus(target: { branch?: string; sha?: string; pr?: number }): Promise<CiStatus | undefined> {
    this.calls.push(target);
    if (target.pr === 99) return undefined;
    return { repository: 'acme/app', target: { branch: target.branch ?? 'main' },
      runs: [{ workflow: 'CI', status: 'completed', conclusion: 'failure', sha: sha('f'), title: 'Add the time zone', branch: 'main', event: 'push',
        url: 'https://github.com/acme/app/actions/runs/2', failedJobs: [{ name: 'test', url: 'https://github.com/acme/app/actions/runs/2/job/7', step: 'npm test' }] }],
      deployment: { sha: sha('a'), environment: 'production', state: 'success', createdAt: '2026-10-31T09:05:00Z', notDeployed: 2,
        undeployed: [{ sha: sha('f'), title: 'Add the time zone' }, { sha: sha('e'), title: 'Fix the retry worker' }] } };
  }
}

function toolboxFor(code: CodePort, ciStatus: boolean | undefined) {
  return buildToolbox({ actor: { id: 'lead', displayName: 'Lead', verified: true }, request: 'did CI pass on main?', sessionId: 's', eventId: 'e',
    policy: new AllowlistPolicy(new Set(['lead'])), code, board: new DemoBoard(), completed: new Map(), onReceipt: async () => {}, ciStatus });
}

test('the ci_status tool is offered only when the flag is on', () => {
  assert.equal(toolboxFor(new FakeCi(), undefined).toolbox.specs.some(spec => spec.name === 'ci_status'), false);
  assert.equal(toolboxFor(new FakeCi(), true).toolbox.specs.some(spec => spec.name === 'ci_status'), true);
});

test('the ci_status tool reports results with links, the failed step and the deployment, and keeps the run as a source', async () => {
  const code = new FakeCi();
  const { toolbox, report } = toolboxFor(code, true);
  const out = await toolbox.run('ci_status', {});
  assert.equal(out.isError, undefined);
  assert.match(out.content, /CI: failure on fffffff "Add the time zone" \(main, not deployed\), push https:\/\/github\.com\/acme\/app\/actions\/runs\/2/);
  assert.match(out.content, /failed job: test, at step "npm test"/);
  assert.match(out.content, /Deployed: aaaaaaa to production \(success/);
  assert.match(out.content, /2 commit\(s\) on main are not deployed yet/);
  assert.match(out.content, /Not deployed yet \(newest first\):\n- fffffff Add the time zone\n- eeeeeee Fix the retry worker\n/);
  assert.match(out.content, /a change in aaaaaaa or an older commit on main is\./);
  assert.equal(report.codeReferences[0]?.url, 'https://github.com/acme/app/actions/runs/2');
  await toolbox.run('ci_status', { pr: 7, sha: 'abc1234' });
  assert.deepEqual(code.calls.at(-1), { pr: 7 }, 'a PR wins over a sha');
  assert.equal((await toolbox.run('ci_status', { pr: 99 })).isError, true);
  assert.equal((await toolbox.run('ci_status', { sha: 'zzz' })).isError, true);
  assert.equal((await toolbox.run('ci_status', { pr: 'seven' })).isError, true);
});
