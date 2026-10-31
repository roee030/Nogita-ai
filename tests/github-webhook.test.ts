import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GitHubCode } from '../src/adapters/github.ts';
import { acceptGitHubWebhook, GitHubRefreshQueue, githubWebhookConfigured, parseGitHubPush,
  verifyGitHubWebhookSignature } from '../src/app/github-webhook.ts';

const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);
const OLD_TREE = 'a'.repeat(40);
const NEW_TREE = 'b'.repeat(40);
const OLD_BLOB = 'c'.repeat(40);
const NEW_BLOB = 'd'.repeat(40);
const WEBHOOK_SECRET = 'github-webhook-secret';

function githubFixture() {
  let head = OLD_SHA;
  const calls: string[] = [];
  const commits = new Map([
    [OLD_SHA, { sha: OLD_SHA, commit: { tree: { sha: OLD_TREE } } }],
    [NEW_SHA, { sha: NEW_SHA, commit: { tree: { sha: NEW_TREE } } }],
  ]);
  const response = (body: unknown) => Response.json(body);
  const http = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('/commits/main')) return response(commits.get(head));
    if (path.endsWith(`/commits/${OLD_SHA}`)) return response(commits.get(OLD_SHA));
    if (path.endsWith(`/commits/${NEW_SHA}`)) return response(commits.get(NEW_SHA));
    if (path.endsWith('/git/trees/main')) return response({ sha: head === OLD_SHA ? OLD_TREE : NEW_TREE,
      tree: [{ path: 'src/value.ts', type: 'blob', sha: head === OLD_SHA ? OLD_BLOB : NEW_BLOB, size: 20 }] });
    if (path.endsWith(`/git/trees/${OLD_TREE}`)) return response({ sha: OLD_TREE,
      tree: [{ path: 'src/value.ts', type: 'blob', sha: OLD_BLOB, size: 20 }] });
    if (path.endsWith(`/git/trees/${NEW_TREE}`)) return response({ sha: NEW_TREE,
      tree: [{ path: 'src/value.ts', type: 'blob', sha: NEW_BLOB, size: 20 }] });
    if (path.endsWith(`/git/blobs/${OLD_BLOB}`)) return response({ encoding: 'base64', content: Buffer.from('export const value=1').toString('base64') });
    if (path.endsWith(`/git/blobs/${NEW_BLOB}`)) return response({ encoding: 'base64', content: Buffer.from('export const value=2').toString('base64') });
    return new Response('missing fixture', { status: 404 });
  };
  return { http: http as typeof fetch, calls, moveHead: () => { head = NEW_SHA; } };
}

function publicArchive(content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write('app-commit/src/value.ts', 0, 'utf8');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('0', 156, 'ascii');
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
}

function gitAdvertisement(ref: string, sha: string): Buffer {
  const record = `${sha} ${ref}\0multi_ack\n`;
  const packet = (payload: string) => `${(Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0')}${payload}`;
  return Buffer.from(`${packet('# service=git-upload-pack\n')}0000${packet(record)}0000`);
}

test('push refresh pins the snapshot to the delivered commit and readiness compares it with live branch head', async () => {
  const fixture = githubFixture();
  const github = new GitHubCode({ token: 'test', owner: 'acme', repo: 'app', ref: 'main' }, fixture.http,
    { indexTtlMs: 60_000 });
  await github.prepare();
  fixture.moveHead();

  await github.refreshIndex(NEW_SHA);
  const status = await github.indexStatus();

  assert.deepEqual(status, { indexedSha: NEW_SHA, headSha: NEW_SHA, current: true });
  assert.match((await github.readFile('src/value.ts'))!.text, /value=2/);
  assert.ok(fixture.calls.some(url => url.endsWith(`/commits/${NEW_SHA}`)));
});

test('public repository push refresh downloads the delivered SHA without rediscovering a moving branch', async () => {
  const requested: string[] = [];
  const http: typeof fetch = async input => {
    const url = String(input);
    requested.push(url);
    if (url === `https://codeload.github.com/acme/app/tar.gz/${NEW_SHA}`) {
      return new Response(new Uint8Array(publicArchive('export const value=2')));
    }
    if (url.endsWith('/info/refs?service=git-upload-pack')) return new Response(
      new Uint8Array(gitAdvertisement('refs/heads/main', NEW_SHA)),
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    return new Response('unexpected request', { status: 404 });
  };
  const github = new GitHubCode({ publicRepo: true, owner: 'acme', repo: 'app', ref: 'main' }, http);

  await github.refreshIndex(NEW_SHA);

  assert.match((await github.readFile('src/value.ts'))!.text, /value=2/);
  assert.deepEqual(await github.indexStatus(), { indexedSha: NEW_SHA, headSha: NEW_SHA, current: true });
  assert.equal(requested.some(url => url.startsWith('https://api.github.com/')), false);
});

test('private refresh refuses a commit response that does not match the delivered SHA', async () => {
  const fixture = githubFixture();
  const http: typeof fetch = async (input, init) => String(input).endsWith(`/commits/${NEW_SHA}`)
    ? Response.json({ sha: OLD_SHA, commit: { tree: { sha: OLD_TREE } } })
    : fixture.http(input, init);
  const github = new GitHubCode({ token: 'test', owner: 'acme', repo: 'app', ref: 'main' }, http);

  await assert.rejects(() => github.refreshIndex(NEW_SHA), /requested commit/i);
});

test('concurrent refreshes finish in delivery order when commits share a tree', async () => {
  const latestSha = '3'.repeat(40);
  let head = NEW_SHA;
  let releaseBlob!: () => void;
  const blobBlocked = new Promise<void>(resolve => { releaseBlob = resolve; });
  const http: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/commits/main')) return Response.json({ sha: head, commit: { tree: { sha: NEW_TREE } } });
    if (path.endsWith(`/commits/${NEW_SHA}`)) return Response.json({ sha: NEW_SHA, commit: { tree: { sha: NEW_TREE } } });
    if (path.endsWith(`/commits/${latestSha}`)) return Response.json({ sha: latestSha, commit: { tree: { sha: NEW_TREE } } });
    if (path.endsWith(`/git/trees/${NEW_TREE}`)) return Response.json({ sha: NEW_TREE,
      tree: [{ path: 'src/value.ts', type: 'blob', sha: NEW_BLOB, size: 20 }] });
    if (path.endsWith(`/git/blobs/${NEW_BLOB}`)) { await blobBlocked; return Response.json({ encoding: 'base64',
      content: Buffer.from('export const value=2').toString('base64') }); }
    return new Response('missing fixture', { status: 404 });
  };
  const github = new GitHubCode({ token: 'test', owner: 'acme', repo: 'app', ref: 'main' }, http);

  const first = github.refreshIndex(NEW_SHA);
  head = latestSha;
  const second = github.refreshIndex(latestSha);
  releaseBlob();
  await Promise.all([first, second]);

  assert.deepEqual(await github.indexStatus(), { indexedSha: latestSha, headSha: latestSha, current: true });
});

test('a delayed older push cannot regress the snapshot behind the live branch head', async () => {
  const fixture = githubFixture();
  const github = new GitHubCode({ token: 'test', owner: 'acme', repo: 'app', ref: 'main' }, fixture.http);
  await github.prepare();
  fixture.moveHead();

  await github.refreshIndex(NEW_SHA);
  await github.refreshIndex(OLD_SHA);

  assert.deepEqual(await github.indexStatus(), { indexedSha: NEW_SHA, headSha: NEW_SHA, current: true });
  assert.match((await github.readFile('src/value.ts'))!.text, /value=2/);
});

test('GitHub webhook verifies the raw request body with HMAC-SHA256', () => {
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: NEW_SHA });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;

  assert.equal(verifyGitHubWebhookSignature(WEBHOOK_SECRET, raw, signature), true);
  assert.equal(verifyGitHubWebhookSignature(WEBHOOK_SECRET, `${raw} `, signature), false);
  assert.equal(verifyGitHubWebhookSignature(WEBHOOK_SECRET, raw, 'sha256=invalid'), false);
});

test('GitHub push parser accepts only this repository and configured branch', () => {
  const payload = { ref: 'refs/heads/main', after: NEW_SHA, repository: { full_name: 'acme/app' } };
  const expected = { owner: 'acme', repo: 'app', ref: 'main' };

  assert.deepEqual(parseGitHubPush(JSON.stringify(payload), 'push', expected), { sha: NEW_SHA });
  assert.equal(parseGitHubPush(JSON.stringify({ ...payload, ref: 'refs/heads/feature' }), 'push', expected), null);
  assert.equal(parseGitHubPush(JSON.stringify({ ...payload, repository: { full_name: 'other/app' } }), 'push', expected), null);
  assert.equal(parseGitHubPush(JSON.stringify({ ...payload, repository: { full_name: {} } }), 'push', expected), null);
  assert.equal(parseGitHubPush(JSON.stringify(payload), 'ping', expected), null);
  assert.equal(parseGitHubPush('{', 'push', expected), null);
});

test('enabled webhook requires a strong secret and acknowledges before refresh finishes', async () => {
  assert.equal(githubWebhookConfigured(false, undefined), true);
  assert.equal(githubWebhookConfigured(true, 'short'), false);
  assert.equal(githubWebhookConfigured(true, WEBHOOK_SECRET), true);
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: NEW_SHA, repository: { full_name: 'acme/app' } });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;
  let release!: () => void;
  let finished = false;
  const refresh = new Promise<void>(resolve => { release = resolve; });

  const accepted = acceptGitHubWebhook({ secret: WEBHOOK_SECRET, raw, signature, event: 'push',
    expected: { owner: 'acme', repo: 'app', ref: 'main' }, refresh: async () => { await refresh; finished = true; } });

  assert.deepEqual(accepted, { status: 202, response: { ok: true, acceptedSha: NEW_SHA } });
  assert.equal(finished, false);
  release();
  await refresh;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true);
});

test('refresh queue retries transient failures and reports only exhausted work', async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const queue = new GitHubRefreshQueue(async () => {
    attempts++;
    if (attempts < 3) throw new Error('temporary GitHub failure');
  }, error => errors.push(error), { maxAttempts: 3, retryDelayMs: 0 });

  await queue.enqueue(NEW_SHA);

  assert.equal(attempts, 3);
  assert.deepEqual(errors, []);
});
