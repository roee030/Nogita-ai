import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../src/adapters/slack.ts';
import { JiraBoard, adfParagraph } from '../src/adapters/jira.ts';
import { MondayBoard } from '../src/adapters/monday.ts';
import { GitHubCode } from '../src/adapters/github.ts';
import { RecallMeeting } from '../src/adapters/recall.ts';

const issue = { title: 'Fix auth tokens', description: 'Check SameSite and CSRF settings', requestId: 'id-1' };
test('Slack signatures: valid HMAC, tamper/replay refused', () => {
  const secret = 'test-secret'; const now = 1_700_000_000;
  const body = '{"type":"url_verification","challenge":"xyz"}';
  const signature = `v0=${createHmac('sha256',secret).update(`v0:${now}:${body}`).digest('hex')}`;
  assert.equal(verifySlackSignature(secret, String(now), signature, body, now), true);
  assert.equal(verifySlackSignature(secret, String(now), signature, `${body} `, now), false);
  assert.equal(verifySlackSignature(secret, String(now), signature, body, now + 500), false);
});
test('Jira Cloud issue body contains ADF and no guessed assignee', async () => {
  let request: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/rest/api/3/search/jql')) {
      return new Response(JSON.stringify({ issues: [], nextPageToken: null }), { status: 200 });
    }
    request = JSON.parse(String(options?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ key: 'NG-42' }), { status: 201 });
  };
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, mockFetch);
  const receipt = await jira.createTask(issue);
  assert.equal(receipt.url, 'https://sample.atlassian.net/browse/NG-42');
  const fields = request?.fields as Record<string,unknown>;
  assert.deepEqual(fields.description, adfParagraph(issue.description));
  assert.equal(fields.assignee, undefined);
});
test('Jira rejects unknown assignee before network call', async () => {
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task', allowedAssigneeIds: new Set(['trusted']) });
  await assert.rejects(() => jira.createTask({ ...issue, assigneeId: 'unknown' }), /allowlist/);
});
test('Jira resolves an internal identity to the provider account ID', async () => {
  let request: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/rest/api/3/search/jql')) {
      return new Response(JSON.stringify({ issues: [], nextPageToken: null }), { status: 200 });
    }
    request = JSON.parse(String(options?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ key: 'NG-43' }), { status: 201 });
  };
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task',
    resolveAssigneeId: id => id === 'roee' ? 'jira-roee' : undefined }, mockFetch);
  await jira.createTask({ ...issue, assigneeId: 'roee' });
  const fields = request?.fields as Record<string, unknown>;
  assert.deepEqual(fields.assignee, { accountId: 'jira-roee' });
});
test('Jira create stores only a hashed request marker', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = async (url, options) => {
    const call = { url: String(url), body: JSON.parse(String(options?.body)) as Record<string, unknown> };
    calls.push(call);
    if (call.url.endsWith('/rest/api/3/search/jql')) {
      return new Response(JSON.stringify({ issues: [], nextPageToken: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: '10042', key: 'NG-42', self: call.url + '/10042' }), { status: 201 });
  };
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, mockFetch);
  await jira.createTask({ ...issue, requestId: 'private-retry-id' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://sample.atlassian.net/rest/api/3/search/jql');
  assert.deepEqual(calls[0]!.body, {
    jql: 'project = "NG" AND creator = currentUser() ORDER BY created DESC',
    maxResults: 100,
    fields: ['key'],
    properties: ['com.nogita.request.v1'],
  });
  assert.equal(JSON.stringify(calls).includes('private-retry-id'), false);
  assert.deepEqual(calls[1]!.body.properties, [{
    key: 'com.nogita.request.v1',
    value: { digest: '8fb365c1f764dcb1d6d35678ae3c9f2983b6b1b6b7f2430ec446b9960927c642' },
  }]);
});
test('Jira retry recovers an existing issue without creating', async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ issues: [{
      id: '10042', key: 'NG-42', self: 'https://sample.atlassian.net/rest/api/3/issue/10042',
      properties: { 'com.nogita.request.v1': {
        digest: '8fb365c1f764dcb1d6d35678ae3c9f2983b6b1b6b7f2430ec446b9960927c642',
      } },
    }], nextPageToken: null }), { status: 200 });
  };
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, mockFetch);
  const receipt = await jira.createTask({ ...issue, requestId: 'private-retry-id' });

  assert.equal(receipt.label, 'NG-42');
  assert.equal(receipt.url, 'https://sample.atlassian.net/browse/NG-42');
  assert.deepEqual(calls, ['https://sample.atlassian.net/rest/api/3/search/jql']);
});
test('Jira lookup failure prevents a possibly duplicate create', async () => {
  let calls = 0;
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, async () => {
      calls++;
      return new Response('', { status: 503 });
    });
  await assert.rejects(() => jira.createTask(issue), /Jira recovery search failed: HTTP 503/);
  assert.equal(calls, 1);
});
test('Jira malformed recovery data fails closed', async () => {
  let calls = 0;
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, async () => {
      calls++;
      return new Response(JSON.stringify({ issues: 'not-an-array' }), { status: 200 });
    });
  await assert.rejects(() => jira.createTask(issue), /Jira recovery search returned invalid data/);
  assert.equal(calls, 1);
});
test('Jira malformed recovery marker prevents a create', async () => {
  let calls = 0;
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, async () => {
      calls++;
      return new Response(JSON.stringify({ issues: [{
        id: '10042', key: 'NG-42', self: 'https://sample.atlassian.net/rest/api/3/issue/10042',
        properties: { 'com.nogita.request.v1': 'corrupt' },
      }], nextPageToken: null }), { status: 200 });
    });
  await assert.rejects(() => jira.createTask(issue), /Jira recovery search returned invalid data/);
  assert.equal(calls, 1);
});
test('Monday GraphQL returns verified item link, never guesses assignment', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({
    data: { create_item: { id: '123', url: 'https://example.monday.com/boards/7/pulses/123' } } }), { status: 200 });
  const monday = new MondayBoard('dev-token', 7, 'text_description', mockFetch);
  assert.equal((await monday.createTask(issue)).kind, 'task');
  await assert.rejects(() => monday.createTask({ ...issue, assigneeId: 'person1' }), /mapping/);
});
test('GitHub source lookup only shows discovered relevant source files', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/auth.ts', type: 'blob', sha: 'b'.repeat(40), size: 100 },
      { path: 'node_modules/auth.ts', type: 'blob', sha: 'c'.repeat(40), size: 100 },
      { path: 'src/payment.ts', type: 'blob', sha: 'd'.repeat(40), size: 100 },
    ] }));
    if (u.includes('/git/blobs/')) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from(u.endsWith(`/git/blobs/${'b'.repeat(40)}`)
        ? 'export function auth() { return true; }' : 'export const payment = false;').toString('base64'),
    }));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const out = await git.findEvidence('auth');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, 'src/auth.ts');
  assert.match(out[0]?.url ?? '', /github.com\/example\/app/);
});
test('GitHub public source lookup omits credentials from every request', async () => {
  const authorizationHeaders: Array<string | null> = [];
  const fakeFetch: typeof fetch = async (url, options) => {
    authorizationHeaders.push(new Headers(options?.headers).get('Authorization'));
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'e'.repeat(40), tree: [
      { path: 'src/public.ts', type: 'blob', sha: 'f'.repeat(40), size: 100 },
    ] }));
    if (u.endsWith(`/git/blobs/${'f'.repeat(40)}`)) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from('export const publicRepository = true;').toString('base64'),
    }));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: '', publicRepo: true, owner: 'example', repo: 'public-app', ref: 'main' }, fakeFetch);
  const out = await git.findEvidence('public');
  assert.equal(out[0]?.path, 'src/public.ts');
  assert.deepEqual(authorizationHeaders, [null, null]);
});
test('GitHub source lookup finds code terms inside generically named files and returns matching context', async () => {
  const fetched: string[] = [];
  const source = [
    'export async function handleSession(session: Session) {',
    '  const startedAt = Date.now();',
    '  const owner = await session.getOwner();',
    '  const settings = await session.getSettings();',
    '  const active = await session.isActive();',
    '  if (!active) return null;',
    '  const pending = await session.getPendingWork();',
    '  if (session.expiresSoon) await session.refresh();',
    '  await session.recordActivity(startedAt);',
    '  return { owner, settings, pending };',
    '}',
  ].join('\n');
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: '1'.repeat(40), tree: [
      { path: 'src/engine.ts', type: 'blob', sha: '2'.repeat(40), size: source.length },
      { path: 'src/other.ts', type: 'blob', sha: '3'.repeat(40), size: 50 },
    ] }));
    if (u.includes('/git/blobs/')) {
      fetched.push(u);
      const content = u.endsWith(`/git/blobs/${'2'.repeat(40)}`) ? source : 'export const unrelated = 1;';
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(content).toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const out = await git.findEvidence('where is expiresSoon checked');
  assert.equal(out[0]?.path, 'src/engine.ts');
  assert.match(out[0]?.excerpt ?? '', /expiresSoon/);
  assert.doesNotMatch(out[0]?.excerpt ?? '', /handleSession/);
  assert.equal(fetched.length, 2);
});
test('GitHub evidence excerpt prioritizes the window matching the most distinct query terms', async () => {
  const source = [
    ...Array.from({ length: 140 }, (_, index) => `// session activity ${index}`),
    'if (session.expiresSoon) await session.refresh();',
  ].join('\n');
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'c'.repeat(40), tree: [
      { path: 'src/session.ts', type: 'blob', sha: 'd'.repeat(40), size: source.length },
    ] }));
    if (u.includes('/git/blobs/')) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from(source).toString('base64'),
    }));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const excerpt = (await git.findEvidence('session expiresSoon'))[0]?.excerpt ?? '';
  assert.match(excerpt, /expiresSoon/);
});
test('GitHub API JSON parsing errors never include a response-body prefix', async () => {
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, async () =>
    new Response('SENSITIVE-PLACEHOLDER-CONTENT', { status: 200 }));
  await assert.rejects(() => git.findEvidence('authentication'), error => {
    assert.match((error as Error).message, /invalid JSON/);
    assert.doesNotMatch((error as Error).message, /SENSITIVE/);
    return true;
  });
});
test('GitHub source lookup reuses a revision index and rebuilds it after the ref changes', async () => {
  let revision = 1;
  const blobCalls: string[] = [];
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: String(revision).padStart(40, '0'), tree: [
      { path: 'src/engine.ts', type: 'blob', sha: String(revision + 2).padStart(40, '0'), size: 100 },
    ] }));
    if (u.includes('/git/blobs/')) {
      blobCalls.push(u);
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(`export const lifecycle = 'revision-${revision}';`).toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-1/);
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-1/);
  assert.equal(blobCalls.length, 1);
  revision = 2;
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-2/);
  assert.equal(blobCalls.length, 2);
});
test('GitHub source index can be warmed before the first question', async () => {
  let blobCalls = 0;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/repo.ts', type: 'blob', sha: 'b'.repeat(40), size: 60 },
    ] }));
    if (u.includes('/git/blobs/')) {
      blobCalls++;
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('export const sessionState = "ready";').toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await git.prepare();
  assert.equal((await git.findEvidence('session state'))[0]?.path, 'src/repo.ts');
  assert.equal(blobCalls, 1);
});
test('GitHub source lookup excludes secrets, locks and generated files and retries malformed blobs', async () => {
  const requested: string[] = [];
  let malformed = true;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: '4'.repeat(40), tree: [
      { path: '.env', type: 'blob', sha: '5'.repeat(40), size: 40 },
      { path: '.env.example', type: 'blob', sha: '6'.repeat(40), size: 40 },
      { path: '.env_local.json', type: 'blob', sha: '1'.repeat(40), size: 40 },
      { path: 'secrets/prod.json', type: 'blob', sha: '2'.repeat(40), size: 40 },
      { path: 'config/service-account.json', type: 'blob', sha: '3'.repeat(40), size: 40 },
      { path: 'config/secrets.yaml', type: 'blob', sha: 'a'.repeat(40), size: 40 },
      { path: 'credentials.json', type: 'blob', sha: 'b'.repeat(40), size: 40 },
      { path: 'package-lock.json', type: 'blob', sha: '7'.repeat(40), size: 50 },
      { path: 'dist/app.js', type: 'blob', sha: '8'.repeat(40), size: 50 },
      { path: 'src/broken.ts', type: 'blob', sha: '9'.repeat(40), size: 20 },
      { path: 'src/auth.ts', type: 'blob', sha: '0'.repeat(40), size: 50 },
    ] }));
    if (u.includes('/git/blobs/')) {
      requested.push(u);
      if (u.endsWith(`/git/blobs/${'9'.repeat(40)}`) && malformed) {
        malformed = false;
        return new Response(JSON.stringify({ encoding: 'base64', content: 'not valid base64!' }));
      }
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('export function rotateToken() {}').toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await assert.rejects(() => git.findEvidence('rotate token'), /invalid blob/i);
  const out = await git.findEvidence('rotate token');
  assert.deepEqual(requested.sort(), [
    `https://api.github.com/repos/example/app/git/blobs/${'0'.repeat(40)}`,
    `https://api.github.com/repos/example/app/git/blobs/${'0'.repeat(40)}`,
    `https://api.github.com/repos/example/app/git/blobs/${'9'.repeat(40)}`,
    `https://api.github.com/repos/example/app/git/blobs/${'9'.repeat(40)}`,
  ]);
  assert.equal(out[0]?.path, 'src/auth.ts');
});
test('GitHub source lookup retries an index after a blob request fails', async () => {
  let fail = true;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/engine.ts', type: 'blob', sha: 'b'.repeat(40), size: 100 },
    ] }));
    if (u.endsWith(`/git/blobs/${'b'.repeat(40)}`)) {
      if (fail) { fail = false; return new Response('unavailable', { status: 503 }); }
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('export const retryPolicy = true;').toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await assert.rejects(() => git.findEvidence('retry policy'), /HTTP 503/);
  assert.equal((await git.findEvidence('retry policy'))[0]?.path, 'src/engine.ts');
});
test('GitHub source lookup refuses truncated trees rather than silently indexing a partial repository', async () => {
  let blobRequests = 0;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), truncated: true, tree: [
      { path: 'src/auth.ts', type: 'blob', sha: 'b'.repeat(40), size: 100 },
    ] }));
    if (u.includes('/git/blobs/')) blobRequests++;
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await assert.rejects(() => git.findEvidence('auth'), /tree truncated/i);
  assert.equal(blobRequests, 0);
});
test('GitHub source lookup rejects missing credentials unless public mode is explicit', () => {
  assert.throws(() => new GitHubCode({ token: '', owner: 'example', repo: 'app', ref: 'main' }), /configuration invalid/);
});
test('Recall joins only approved host; sends actual chat receipt API request', async () => {
  const calls: Array<{url: string;body:unknown}> = [];
  const mockFetch: typeof fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(String(opts?.body)) });
    return new Response(JSON.stringify({id:'2b3c4d5e-1234-4567-8899-123456789abc'}), { status: 200 });
  };
  const recall = new RecallMeeting('m', 'secret', 'us-east-1', mockFetch);
  await assert.rejects(() => recall.join('https://meet.google.com.attacker.invalid/abc'), /allowlist/);
  await recall.join('https://meet.google.com/abc-defg-hij');
  await recall.sendCompletion({ provider: 'jira', kind: 'task', label: 'NG-42', url: 'https://sample.atlassian.net/browse/NG-42' });
  assert.equal(calls.length,2);
  assert.match(calls[1]!.url, /send_chat_message/);
  assert.deepEqual(calls[1]!.body, { to: 'everyone', message: 'NG-42: https://sample.atlassian.net/browse/NG-42' });
  assert.equal(await recall.raiseHand(), false);
  await assert.rejects(() => recall.speak('hi'), /not wired/);
});
