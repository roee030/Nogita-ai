import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GitHubCode } from '../src/adapters/github.ts';
import { parseGitHubPush, verifyGitHubWebhookSignature } from '../src/app/github-webhook.ts';

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
    if (url.endsWith('/commits/main')) return Response.json({ sha: NEW_SHA, commit: { tree: { sha: NEW_TREE } } });
    return new Response('unexpected request', { status: 404 });
  };
  const github = new GitHubCode({ publicRepo: true, owner: 'acme', repo: 'app', ref: 'main' }, http);

  await github.refreshIndex(NEW_SHA);

  assert.match((await github.readFile('src/value.ts'))!.text, /value=2/);
  assert.deepEqual(await github.indexStatus(), { indexedSha: NEW_SHA, headSha: NEW_SHA, current: true });
  assert.equal(requested.some(url => url.includes('info/refs')), false);
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
