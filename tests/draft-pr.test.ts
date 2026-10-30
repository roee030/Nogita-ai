import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubDrafts, draftBranchName } from '../src/adapters/github-drafts.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';
import { buildDependencies } from '../src/app/config.ts';
import { loadTenantConfig } from '../src/app/tenant-config.ts';
import type { ActionReceipt, PullRequestPort } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };

/** A tiny GitHub: refs, contents and pulls for one repository, recording every write. */
function githubFake() {
  const branches = new Map<string, string>([['main', 'sha-main']]);
  const files = new Map<string, string>();
  const pulls: Array<{ number: number; head: string; base: string; draft: boolean; title: string }> = [];
  const writes: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer t0ken$/);
    const path = url.pathname.replace('/repos/acme/shop', '');
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (method === 'GET' && path === '/pulls') {
      const head = url.searchParams.get('head')!.replace('acme:', '');
      return json(pulls.filter(pr => pr.head === head).map(pr => ({ number: pr.number, html_url: `https://github.com/acme/shop/pull/${pr.number}`, draft: pr.draft })));
    }
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const sha = branches.get(decodeURIComponent(path.slice('/git/ref/heads/'.length)));
      return sha ? json({ object: { sha } }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = String(body.ref).replace('refs/heads/', '');
      if (branches.has(name)) return json({ message: 'Reference already exists' }, 422);
      branches.set(name, String(body.sha));
      return json({ ref: body.ref }, 201);
    }
    if (method === 'PUT' && path.startsWith('/contents/')) {
      const key = `${body.branch}:${decodeURIComponent(path.slice('/contents/'.length))}`;
      if (files.has(key)) return json({ message: '"sha" wasn\'t supplied' }, 422);
      files.set(key, Buffer.from(String(body.content), 'base64').toString('utf8'));
      return json({ content: {} }, 201);
    }
    if (method === 'POST' && path === '/pulls') {
      const pr = { number: 40 + pulls.length + 1, head: String(body.head), base: String(body.base), draft: body.draft === true, title: String(body.title) };
      pulls.push(pr);
      return json({ number: pr.number, html_url: `https://github.com/acme/shop/pull/${pr.number}`, draft: pr.draft }, 201);
    }
    return json({ message: `fake has no ${method} ${path}` }, 404);
  }) as typeof fetch;
  return { http, branches, files, pulls, writes };
}

test('a draft PR is a new branch, one note and a draft pull request; a retry reuses them', async () => {
  const fake = githubFake();
  const drafts = new GitHubDrafts({ token: 't0ken', owner: 'acme', repo: 'shop', ref: 'main' }, fake.http);
  const input = { title: 'Retry payments with jitter', description: 'Add jitter to the retry worker in src/payments/retry.ts.', requestId: 's:e:pr:1' };
  const receipt = await drafts.openDraft(input);
  assert.deepEqual(receipt, { provider: 'github', kind: 'draft_pr', label: 'PR #41', url: 'https://github.com/acme/shop/pull/41' });
  const branch = draftBranchName(input.title, input.requestId);
  assert.match(branch, /^nogita\/retry-payments-with-jitter-[0-9a-f]{10}$/);
  assert.equal(fake.branches.get(branch), 'sha-main');
  assert.deepEqual(fake.pulls.map(pr => ({ head: pr.head, base: pr.base, draft: pr.draft })), [{ head: branch, base: 'main', draft: true }]);
  assert.match([...fake.files.values()][0]!, /Add jitter to the retry worker/);
  // Never a merge, a delete, or a write to an existing branch.
  assert.ok(fake.writes.every(write => /^(?:POST \/git\/refs|PUT \/contents\/\.nogita\/|POST \/pulls)$/.test(write.replace(/\/[^/]+\.md$/, '/'))), fake.writes.join(', '));
  assert.ok(!fake.files.has(`main:.nogita/${branch.slice(7)}.md`));

  assert.equal((await drafts.openDraft(input)).label, 'PR #41');
  assert.equal(fake.pulls.length, 1);
});

test('a draft PR whose earlier attempt stopped after the branch finishes on the same branch', async () => {
  const fake = githubFake();
  const drafts = new GitHubDrafts({ token: 't0ken', owner: 'acme', repo: 'shop', ref: 'main' }, fake.http);
  const input = { title: 'Fix login', description: 'Keep the session alive.', requestId: 'crash-1' };
  fake.branches.set(draftBranchName(input.title, input.requestId), 'sha-main');
  assert.equal((await drafts.openDraft(input)).label, 'PR #41');
  assert.equal(fake.pulls.length, 1);
});

test('open_draft_pr is offered only when turned on, and only runs on an explicit request', async () => {
  const opened: string[] = [];
  const drafts: PullRequestPort = { name: 'github', openDraft: async input => {
    opened.push(input.title);
    return { provider: 'github', kind: 'draft_pr', label: 'PR #7', url: 'https://github.com/acme/shop/pull/7' };
  } };
  const receipts: ActionReceipt[] = [];
  const make = (request: string, on = true, actorId = 'lead') => buildToolbox({ actor: { ...lead, id: actorId }, request, sessionId: 's', eventId: 'e',
    policy: new AllowlistPolicy(new Set(['lead']), { draftPullRequests: on }), code: new DemoCode(), board: new DemoBoard(), drafts,
    completed: new Map(), onReceipt: async receipt => { receipts.push(receipt); } }).toolbox;
  const names = (toolbox: ReturnType<typeof make>) => toolbox.specs.map(spec => spec.name);
  assert.ok(names(make('open a draft PR for the retry fix')).includes('open_draft_pr'));
  assert.ok(!names(make('open a draft PR for the retry fix', false)).includes('open_draft_pr'));
  assert.ok(!names(make('open a draft PR for the retry fix', true, 'guest')).includes('open_draft_pr'));

  const refused = await make('how would we fix the retry?').run('open_draft_pr', { title: 'Retry fix', description: 'x' });
  assert.equal(refused.isError, true);
  assert.deepEqual(opened, []);
  const done = await make('Nogita, open a draft PR for the retry fix').run('open_draft_pr', { title: 'Retry fix', description: 'Add jitter.' });
  assert.match(done.content, /Opened PR #7 as a draft/);
  assert.deepEqual(opened, ['Retry fix']);
  assert.equal(receipts.length, 1);
});

test('draft PRs are wired only for a repository that turned them on with a token', () => {
  const base = { REPO_PROVIDER: 'github', GITHUB_OWNER: 'acme', GITHUB_REPO: 'shop', AUTHORIZED_ACTOR_IDS: 'lead' };
  assert.equal(buildDependencies(loadTenantConfig({ ...base, GITHUB_TOKEN: 't' })).drafts, undefined);
  assert.equal(buildDependencies(loadTenantConfig({ ...base, GITHUB_PUBLIC_REPO: 'true', GITHUB_DRAFT_PRS: 'true' })).drafts, undefined);
  const on = buildDependencies(loadTenantConfig({ ...base, GITHUB_TOKEN: 't', GITHUB_DRAFT_PRS: 'true' }));
  assert.ok(on.drafts);
  assert.equal(on.policy.mayDraftPR(lead), true);
  assert.equal(on.policy.mayDraftPR({ ...lead, verified: false }), false);
});
