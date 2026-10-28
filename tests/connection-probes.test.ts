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
    JIRA_PROJECT_KEY: 'KAN', ATTENDEE_API_KEY: 'secret', SLACK_BOT_TOKEN: 'xoxb-secret' }, async (url, options) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    if (String(url).includes('slack.com')) {
      assert.equal(options?.method, 'POST');
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer xoxb-secret');
      return new Response('{"ok":true}');
    }
    return new Response('{}');
  });
  assert.equal(report.ok, true);
  assert.deepEqual(paths.sort(), ['/api/v1/bots', '/api/auth.test', '/repos/owner/repo/git/trees/main', '/rest/api/3/project/KAN'].sort());
  assert.equal(report.checks.find(check => check.provider === 'slack')?.status, 'connected');
});

test('invalid Jira URLs are reported as configuration errors without aborting other probes', async () => {
  const report = await probeConnections({
    GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo',
    JIRA_BASE_URL: 'not a URL', JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'secret', JIRA_PROJECT_KEY: 'KAN',
  }, async () => new Response('{}'));
  assert.equal(report.checks[0]?.status, 'connected');
  assert.equal(report.checks[1]?.status, 'invalid_configuration');
  assert.equal(report.checks[2]?.status, 'unconfigured');
  assert.equal(report.ok, false);
});

test('Slack HTTP success with an API auth error is reported as disconnected', async () => {
  const report = await probeConnections({ SLACK_BOT_TOKEN: 'xoxb-invalid' }, async () =>
    new Response('{"ok":false,"error":"invalid_auth"}', { status: 200 }));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.provider === 'slack')?.status, 'failed');
  assert.doesNotMatch(JSON.stringify(report), /invalid_auth|xoxb-invalid/);
});
