import test from 'node:test';
import assert from 'node:assert/strict';
import { probeConnections } from '../src/app/connection-probes.ts';

test('connection probes report failures without exposing credentials or provider bodies', async () => {
  const report = await probeConnections({ GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', GITHUB_TOKEN: 'private-token' },
    async () => new Response('private-provider-body', { status: 403 }));
  assert.equal(report.ok, false);
  assert.equal(report.checks[0]?.status, 'failed');
  assert.equal(report.checks[0]?.httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(report), /private-token|private-provider-body/);
});

test('connection probes verify all configured services with bounded read-only requests', async () => {
  const paths: string[] = [];
  const report = await probeConnections({ GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo',
    JIRA_BASE_URL: 'https://test.atlassian.net', JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'secret',
    JIRA_PROJECT_KEY: 'KAN', ATTENDEE_API_KEY: 'secret' }, async (url, options) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return new Response('{}');
  });
  assert.equal(report.ok, true);
  assert.deepEqual(paths, ['/repos/owner/repo/git/trees/main', '/rest/api/3/project/KAN', '/api/v1/bots']);
});
