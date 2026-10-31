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
    JIRA_PROJECT_KEY: 'KAN', ATTENDEE_API_KEY: 'secret', SLACK_BOT_TOKEN: 'xoxb-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_MODEL: 'claude-haiku-5-5',
    DEEPGRAM_API_KEY: 'deepgram-secret' }, async (url, options) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    if (String(url).includes('slack.com')) {
      assert.equal(options?.method, 'POST');
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer xoxb-secret');
      return new Response('{"ok":true}');
    }
    if (String(url).includes('anthropic.com')) {
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'anthropic-secret');
      return new Response('{"data":[{"id":"claude-haiku-5-5"}]}');
    }
    if (String(url).includes('deepgram.com')) {
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Token deepgram-secret');
      return new Response('{"projects":[]}');
    }
    return new Response('{}');
  });
  assert.equal(report.ok, true);
  assert.deepEqual(paths.sort(), ['/api/v1/bots', '/api/auth.test', '/v1/auth/token', '/v1/models',
    '/repos/owner/repo/git/trees/main', '/rest/api/3/project/KAN'].sort());
  assert.deepEqual(report.checks.map(check => check.provider),
    ['github', 'jira', 'slack', 'anthropic', 'deepgram', 'attendee']);
  assert.ok(report.checks.every(check => typeof check.durationMs === 'number' && check.durationMs >= 0));
  assert.equal(report.checks.find(check => check.provider === 'slack')?.status, 'connected');
});

test('Deepgram probe confirms the key with a lightweight authenticated read', async () => {
  const report = await probeConnections({ DEEPGRAM_API_KEY: 'deepgram-secret' }, async (url, options) => {
    assert.equal(String(url), 'https://api.deepgram.com/v1/auth/token');
    assert.equal(options?.method, 'GET');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Token deepgram-secret');
    return new Response('{"projects":[]}');
  });

  assert.equal(report.checks.find(check => check.provider === 'deepgram')?.status, 'connected');
  assert.doesNotMatch(JSON.stringify(report), /deepgram-secret/);
});

test('Deepgram is clearly not required when realtime audio is disabled', async () => {
  const env = {
    GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo',
    JIRA_BASE_URL: 'https://test.atlassian.net', JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'secret',
    JIRA_PROJECT_KEY: 'KAN', ATTENDEE_API_KEY: 'secret', SLACK_BOT_TOKEN: 'xoxb-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_MODEL: 'claude-haiku-5-5',
  };
  const report = await probeConnections(env, async url => String(url).includes('slack.com')
    ? new Response('{"ok":true}')
    : String(url).includes('anthropic.com')
      ? new Response('{"data":[{"id":"claude-haiku-5-5"}]}')
      : new Response('{}'));

  assert.equal(report.checks.find(check => check.provider === 'deepgram')?.status, 'not_required');
  assert.equal(report.ok, true);
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

test('Anthropic probe confirms the configured model through the read-only Models API', async () => {
  const report = await probeConnections({ ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_MODEL: 'claude-haiku-5-5' },
    async (url, options) => {
      assert.equal(new URL(String(url)).pathname, '/v1/models');
      assert.equal(options?.method, 'GET');
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'anthropic-secret');
      assert.equal(new Headers(options?.headers).get('anthropic-version'), '2023-06-01');
      return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-5-5', type: 'model' }] }));
    });
  assert.equal(report.checks.find(check => check.provider === 'anthropic')?.status, 'connected');
  assert.doesNotMatch(JSON.stringify(report), /anthropic-secret|claude-haiku-5-5/);
});

test('Anthropic probe fails safely when the configured model is unavailable', async () => {
  const report = await probeConnections({ ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_MODEL: 'missing-model' },
    async () => new Response(JSON.stringify({ data: [{ id: 'another-model' }] })));
  assert.equal(report.checks.find(check => check.provider === 'anthropic')?.status, 'failed');
  assert.doesNotMatch(JSON.stringify(report), /anthropic-secret|missing-model|another-model/);
});
