import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { verifySlackSignature } from '../src/adapters/slack.ts';
import { JiraBoard, adfParagraph } from '../src/adapters/jira.ts';
import { MondayBoard } from '../src/adapters/monday.ts';
import { GitHubCode } from '../src/adapters/github.ts';
import { RecallMeeting } from '../src/adapters/recall.ts';

const issue = { title: 'Fix auth tokens', description: 'Check SameSite and CSRF settings', requestId: 'id-1' };
function withSourceCommit(fetchTreeAndBlobs: typeof fetch): typeof fetch {
  let lastTreeSha: string | undefined;
  return async (url, options) => {
    const path = String(url);
    if (/\/commits\/[^?]+$/.test(path)) return new Response(JSON.stringify({
      sha: 'c'.repeat(40), commit: { tree: { sha: lastTreeSha } },
    }));
    const response = await fetchTreeAndBlobs(url, options);
    if (path.includes('/git/trees/') && response.ok) {
      const payload = await response.clone().json() as { sha?: string };
      lastTreeSha = payload.sha;
    }
    return response;
  };
}
function testTarGz(path: string, content: string, others: Array<{ path: string; content: string }> = []): Buffer {
  const entries = [{ path, content }, ...others].map(item => {
    const body = Buffer.from(item.content);
    const header = Buffer.alloc(512);
    header.write(`example-app-commit/${item.path}`, 0, 'utf8');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
function testGitAdvertisement(ref: string, sha: string): Buffer {
  const service = '# service=git-upload-pack\n';
  const record = `${sha} ${ref}\0multi_ack\n`;
  const packet = (payload: string) => `${(Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0')}${payload}`;
  return Buffer.from(`${packet(service)}0000${packet(record)}0000`);
}
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const out = await git.findEvidence('auth');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, 'src/auth.ts');
  assert.match(out[0]?.url ?? '', /github.com\/example\/app/);
});
test('GitHub source lookup includes extensionless project configuration files', async () => {
  const requested: string[] = [];
  const entries = [
    { path: 'Dockerfile', sha: 'd'.repeat(40), text: '# production container startup\nFROM node:22' },
    { path: '.gitignore', sha: 'e'.repeat(40), text: 'node_modules\ndist' },
    { path: 'Makefile', sha: 'f'.repeat(40), text: 'test:\n\tnpm test' },
  ];
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: entries.map(entry =>
      ({ path: entry.path, type: 'blob', sha: entry.sha, size: entry.text.length })) }));
    const entry = entries.find(candidate => u.endsWith(`/git/blobs/${candidate.sha}`));
    if (entry) {
      requested.push(entry.path);
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(entry.text).toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  assert.equal((await git.findEvidence('container startup'))[0]?.path, 'Dockerfile');
  assert.equal((await git.findEvidence('npm test target'))[0]?.path, 'Makefile');
  assert.deepEqual(requested.sort(), ['.gitignore', 'Dockerfile', 'Makefile']);
});
test('GitHub commit lookup uses the configured ref and returns grounded recent-change evidence', async () => {
  let requestedUrl = '';
  const fakeFetch: typeof fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify([{ sha: 'a'.repeat(40), html_url: 'https://github.com/example/app/commit/abc123',
      commit: { message: 'Improve full-repository answers', author: { date: '2026-10-27T12:00:00Z' } } }]));
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'release/v2' }, fakeFetch);
  const evidence = await git.findEvidence('what did we push most recently?');
  assert.match(requestedUrl, /\/commits\?sha=release%2Fv2&per_page=10$/);
  assert.equal(evidence[0]?.path, `commit ${'a'.repeat(7)}`);
  assert.equal(evidence[0]?.url, `https://github.com/example/app/commit/${'a'.repeat(40)}`);
  assert.match(evidence[0]?.excerpt ?? '', /Improve full-repository answers/);
  assert.match(evidence[0]?.excerpt ?? '', /2026-10-27/);
  await git.findEvidence('what did we push to main?');
  assert.match(requestedUrl, /\/commits\?sha=main&per_page=10$/);
  await git.findEvidence('what did we push most recently to auth?');
  assert.match(requestedUrl, /\/commits\?sha=release%2Fv2&per_page=10$/);
  await git.findEvidence('what changed in the last release?');
  assert.match(requestedUrl, /\/commits\?sha=release%2Fv2&per_page=10$/);
});
test('GitHub public source lookup omits credentials from every request', async () => {
  const authorizationHeaders: Array<string | null> = [];
  const fakeFetch: typeof fetch = async (url, options) => {
    authorizationHeaders.push(new Headers(options?.headers).get('Authorization'));
    const u = String(url);
    if (u.endsWith('/info/refs?service=git-upload-pack')) return new Response(new Uint8Array(
      testGitAdvertisement('refs/heads/main', 'c'.repeat(40))),
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    if (u === `https://codeload.github.com/example/public-app/tar.gz/${'c'.repeat(40)}`) return new Response(new Uint8Array(testTarGz('src/public.ts',
      'export const publicRepository = true;', [{ path: '.env', content: 'SENSITIVE=credential' }])));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: '', publicRepo: true, owner: 'example', repo: 'public-app', ref: 'main' }, fakeFetch);
  const out = await git.findEvidence('public');
  assert.equal(out[0]?.path, 'src/public.ts');
  assert.equal(out[0]?.url, `https://github.com/example/public-app/blob/${'c'.repeat(40)}/src/public.ts`);
  assert.equal(out.some(item => item.excerpt.includes('SENSITIVE')), false);
  assert.deepEqual(authorizationHeaders, [null, null]);
});
test('public archive never follows a redirect away from pinned GitHub codeload', async () => {
  let requests = 0;
  const fakeFetch: typeof fetch = async url => {
    requests++;
    if (String(url).endsWith('/info/refs?service=git-upload-pack')) return new Response(new Uint8Array(
      testGitAdvertisement('refs/heads/main', 'c'.repeat(40))),
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/archive' } });
  };
  const git = new GitHubCode({ token: '', publicRepo: true, owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await assert.rejects(() => git.findEvidence('auth'), /not trusted/);
  assert.equal(requests, 2);
});
test('public GitHub discovery reports throttling without exposing the response body', async () => {
  const git = new GitHubCode({ publicRepo: true, owner: 'example', repo: 'app', ref: 'main' }, async () =>
    new Response('SENSITIVE-PLACEHOLDER-CONTENT', { status: 429 }));
  await assert.rejects(() => git.findEvidence('auth'), error => {
    assert.equal((error as Error).name, 'CodeLookupRateLimitError');
    assert.doesNotMatch((error as Error).message, /SENSITIVE/);
    return true;
  });
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
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
test('GitHub API refuses oversized JSON before buffering an unbounded response', async () => {
  let readCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      readCount++;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (readCount >= 20) controller.close();
    },
  });
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, async () =>
    new Response(stream, { status: 200 }));
  await assert.rejects(() => git.findEvidence('authentication'), /response size limit/i);
  assert.ok(readCount < 20);
});
test('private repository indexing refuses aggregate source bytes above its budget', async () => {
  const fakeFetch: typeof fetch = async url => {
    if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree:
      Array.from({ length: 65 }, (_, i) => ({ path: `src/file-${i}.ts`, type: 'blob',
        sha: String(i).padStart(40, '0'), size: 1024 * 1024 })) }));
    if (String(url).includes('/commits/')) return new Response(JSON.stringify({ sha: 'c'.repeat(40),
      commit: { tree: { sha: 'a'.repeat(40) } } }));
    throw new Error('blob fetch should not start above aggregate budget');
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  await assert.rejects(() => git.findEvidence('file'), /index size limit/i);
});
test('GitHub API rate limiting is reported distinctly without exposing its response body', async () => {
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, async () =>
    new Response('SENSITIVE-PLACEHOLDER-CONTENT', { status: 403,
      headers: { 'x-ratelimit-remaining': '0' } }));
  await assert.rejects(() => git.findEvidence('authentication'), error => {
    assert.equal((error as Error).name, 'CodeLookupRateLimitError');
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch), { indexTtlMs: 0 });
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-1/);
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-1/);
  assert.equal(blobCalls.length, 1);
  revision = 2;
  assert.match((await git.findEvidence('lifecycle'))[0]?.excerpt ?? '', /revision-2/);
  assert.equal(blobCalls.length, 2);
});
test('GitHub source index refreshes after its TTL and avoids a tree request within the TTL', async () => {
  let time = 0;
  let revision = 1;
  let treeRequests = 0;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.includes('/git/trees/')) {
      treeRequests++;
      return new Response(JSON.stringify({ sha: String(revision).padStart(40, '0'), tree: [
        { path: 'src/state.ts', type: 'blob', sha: String(revision + 2).padStart(40, '0'), size: 100 },
      ] }));
    }
    if (u.includes('/git/blobs/')) return new Response(JSON.stringify({ encoding: 'base64',
      content: Buffer.from(`export const state = 'revision-${revision}';`).toString('base64') }));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch),
    { indexTtlMs: 30, now: () => time });
  assert.match((await git.findEvidence('state'))[0]?.excerpt ?? '', /revision-1/);
  revision = 2;
  assert.match((await git.findEvidence('state'))[0]?.excerpt ?? '', /revision-1/);
  assert.equal(treeRequests, 1);
  time = 31;
  assert.match((await git.findEvidence('state'))[0]?.excerpt ?? '', /revision-2/);
  assert.equal(treeRequests, 2);
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
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
test('secret literals inside an otherwise allowed source file are removed before evidence reaches the model', async () => {
  const jsonSecret = 'SENSITIVE-EXAMPLE-DO-NOT-LEAK-1234567890';
  const tokenSecret = 'TEST-EXAMPLE-TOKEN-VALUE-NEVER-VALID-1234';
  const source = `export const production = { apiKey: "${jsonSecret}", name: "service" };\nconst token = "${tokenSecret}";`;
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/config.ts', type: 'blob', sha: 'b'.repeat(40), size: Buffer.byteLength(source) },
    ] }));
    if (path.endsWith(`/git/blobs/${'b'.repeat(40)}`)) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from(source).toString('base64'),
    }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const evidence = await git.findEvidence('production apiKey token');
  assert.equal(evidence[0]?.path, 'src/config.ts');
  assert.doesNotMatch(evidence[0]?.excerpt ?? '', /SENSITIVE-EXAMPLE|TEST-EXAMPLE-TOKEN-VALUE/);
  assert.match(evidence[0]?.excerpt ?? '', /\[REDACTED\]/);
});
test('unlabelled long literals and multiline private keys never enter repository evidence', async () => {
  const opaqueValue = 'ExampleOpaqueAccessValue1234567890ABCDE';
  const keyBody = 'EXAMPLEPRIVATEKEYBODY1234567890ABCDEF';
  const source = [
    `export const production = { access: "${opaqueValue}", enabled: true };`,
    '/* deployment note',
    '-----BEGIN PRIVATE KEY-----',
    keyBody,
    '-----END PRIVATE KEY-----',
    '*/',
  ].join('\n');
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/config.ts', type: 'blob', sha: 'b'.repeat(40), size: Buffer.byteLength(source) },
    ] }));
    if (path.endsWith(`/git/blobs/${'b'.repeat(40)}`)) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from(source).toString('base64'),
    }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const evidence = await git.findEvidence('production access deployment note');
  assert.equal(evidence[0]?.path, 'src/config.ts');
  assert.doesNotMatch(evidence[0]?.excerpt ?? '', /ExampleOpaqueAccessValue|EXAMPLEPRIVATEKEYBODY|BEGIN PRIVATE KEY/);
  assert.match(evidence[0]?.excerpt ?? '', /\[REDACTED\]/);
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
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  await assert.rejects(() => git.findEvidence('retry policy'), /HTTP 503/);
  assert.equal((await git.findEvidence('retry policy'))[0]?.path, 'src/engine.ts');
});
test('GitHub source lookup expands a truncated tree through pinned subtrees', async () => {
  let blobRequests = 0;
  const fakeFetch: typeof fetch = async url => {
    const u = String(url);
    if (u.endsWith('/git/trees/main?recursive=1')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), truncated: true, tree: [] }));
    if (u.endsWith(`/git/trees/${'a'.repeat(40)}`)) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src', type: 'tree', sha: 'c'.repeat(40) },
    ] }));
    if (u.endsWith(`/git/trees/${'c'.repeat(40)}`)) return new Response(JSON.stringify({ sha: 'c'.repeat(40), tree: [
      { path: 'auth.ts', type: 'blob', sha: 'b'.repeat(40), size: 25 },
    ] }));
    if (u.includes('/git/blobs/')) {
      blobRequests++;
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('export const auth = true;').toString('base64') }));
    }
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  assert.equal((await git.findEvidence('auth'))[0]?.path, 'src/auth.ts');
  assert.equal(blobRequests, 1);
});
test('a medium sized source file does not disable every repository answer', async () => {
  const text = `${'// ordinary source line\n'.repeat(6000)}export const uniqueRepoSymbol = true;`;
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/large.ts', type: 'blob', sha: 'b'.repeat(40), size: Buffer.byteLength(text) },
    ] }));
    if (path.includes('/git/blobs/')) return new Response(JSON.stringify({ encoding: 'base64',
      content: Buffer.from(text).toString('base64') }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const evidence = await git.findEvidence('uniqueRepoSymbol');
  assert.equal(evidence[0]?.path, 'src/large.ts');
  assert.match(evidence[0]?.excerpt ?? '', /uniqueRepoSymbol/);
});
test('one oversized source file does not disable answers from other files', async () => {
  const small = 'export const safeLookup = true;';
  let blobRequests = 0;
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/huge.ts', type: 'blob', sha: 'd'.repeat(40), size: 2 * 1024 * 1024 },
      { path: 'src/small.ts', type: 'blob', sha: 'b'.repeat(40), size: Buffer.byteLength(small) },
    ] }));
    if (path.endsWith(`/git/blobs/${'b'.repeat(40)}`)) {
      blobRequests++;
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(small).toString('base64') }));
    }
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const evidence = await git.findEvidence('safeLookup');
  assert.equal(evidence[0]?.path, 'src/small.ts');
  assert.equal(blobRequests, 1);
  assert.deepEqual(git.getCoverage(), { indexedFiles: 1, skippedLargeFiles: 1 });
});
test('source receipts pin to the exact commit whose tree supplied the evidence', async () => {
  const commitSha = 'c'.repeat(40);
  const treeSha = 'a'.repeat(40);
  const blobSha = 'b'.repeat(40);
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/commits/main')) return new Response(JSON.stringify({
      sha: commitSha, commit: { tree: { sha: treeSha } },
    }));
    if (path.endsWith('/git/trees/main?recursive=1')) return new Response(JSON.stringify({
      sha: treeSha, tree: [{ path: 'src/auth.ts', type: 'blob', sha: blobSha, size: 40 }],
    }));
    if (path.endsWith(`/git/blobs/${blobSha}`)) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from('export const auth = true;').toString('base64'),
    }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const evidence = await git.findEvidence('auth');
  assert.equal(evidence[0]?.url, `https://github.com/example/app/blob/${commitSha}/src/auth.ts`);
  assert.ok(requests[0]?.endsWith('/git/trees/main?recursive=1'));
  assert.ok(requests[1]?.endsWith('/commits/main'));
});
test('a branch moving between tree and commit reads cannot mix source and permalink revisions', async () => {
  const oldTree = 'a'.repeat(40);
  const newTree = 'd'.repeat(40);
  const commitSha = 'c'.repeat(40);
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.endsWith('/git/trees/main?recursive=1')) return new Response(JSON.stringify({
      sha: oldTree, tree: [{ path: 'src/old.ts', type: 'blob', sha: 'b'.repeat(40), size: 30 }],
    }));
    if (path.endsWith('/commits/main')) return new Response(JSON.stringify({
      sha: commitSha, commit: { tree: { sha: newTree } },
    }));
    if (path.endsWith(`/git/trees/${newTree}?recursive=1`)) return new Response(JSON.stringify({
      sha: newTree, tree: [{ path: 'src/new.ts', type: 'blob', sha: 'e'.repeat(40), size: 30 }],
    }));
    if (path.endsWith(`/git/blobs/${'e'.repeat(40)}`)) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from('export const newRevision = true;').toString('base64'),
    }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const evidence = await git.findEvidence('newRevision');
  assert.equal(evidence[0]?.path, 'src/new.ts');
  assert.equal(evidence[0]?.url, `https://github.com/example/app/blob/${commitSha}/src/new.ts`);
});
test('repository configuration questions find the provider wiring instead of generic provider mentions', async () => {
  const blobs = new Map([
    ['b'.repeat(40), 'export const board = env.BOARD_PROVIDER; export const code = env.REPO_PROVIDER;'],
    ['c'.repeat(40), '// environment configuration providers repository board\n'.repeat(4)],
  ]);
  const fakeFetch: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: [
      { path: 'src/app/config.ts', type: 'blob', sha: 'b'.repeat(40), size: blobs.get('b'.repeat(40))!.length },
      { path: 'src/app/readiness.ts', type: 'blob', sha: 'c'.repeat(40), size: blobs.get('c'.repeat(40))!.length },
    ] }));
    const content = blobs.get(path.split('/').at(-1) ?? '');
    if (content) return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(content).toString('base64') }));
    throw new Error(`unexpected URL ${path}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, withSourceCommit(fakeFetch));
  const evidence = await git.findEvidence('How are repository and board providers selected from environment configuration?');
  assert.equal(evidence[0]?.path, 'src/app/config.ts');
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
