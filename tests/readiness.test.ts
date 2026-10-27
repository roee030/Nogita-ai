import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadinessReport } from '../src/app/readiness.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const completeEnv: NodeJS.ProcessEnv = {
  NOGITA_ADMIN_TOKEN: 'admin-secret-that-is-long-enough',
  NOGITA_QUEUE_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  SLACK_APP_TOKEN: 'xapp-test-secret', SLACK_BOT_TOKEN: 'xoxb-test-secret',
  SLACK_ALLOWED_TEAM_IDS: 'team-secret-id', SLACK_BOT_USER_ID: 'bot-secret-id',
  BOARD_PROVIDER: 'jira', JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'private@example.com', JIRA_API_TOKEN: 'jira-secret', JIRA_PROJECT_KEY: 'KAN',
  REPO_PROVIDER: 'github', GITHUB_TOKEN: 'github-secret', GITHUB_OWNER: 'private-owner', GITHUB_REPO: 'private-repo',
  MEETING_PROVIDER: 'attendee', ATTENDEE_API_KEY: 'attendee-secret',
  ATTENDEE_PRIVACY_REVIEWED: 'true', ATTENDEE_WEBHOOK_URL: 'https://service.example/webhooks/attendee',
  ATTENDEE_WEBHOOK_SECRET: 'webhook-secret',
  NOGITA_MODE: 'live', ANTHROPIC_API_KEY: 'model-secret', ANTHROPIC_MODEL: 'private-model-name',
};

test('readiness reports a fully configured product without exposing configuration values', () => {
  const identities = new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'private-speaker-id',
  }]);
  const report = buildReadinessReport(completeEnv, identities, '22.16.0');
  assert.equal(report.ok, true);
  assert.ok(report.checks.every(check => check.status === 'ready'));
  const serialized = JSON.stringify(report);
  for (const secret of [
    'admin-secret-that-is-long-enough', 'xapp-test-secret', 'xoxb-test-secret',
    'team-secret-id', 'bot-secret-id', 'private@example.com', 'jira-secret',
    'github-secret', 'private-owner', 'private-repo', 'attendee-secret',
    'https://service.example/webhooks/attendee', 'webhook-secret', 'model-secret',
    'private-model-name',
  ]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('private-speaker-id'), false);
});

test('reasoning readiness accepts the maintained default model when only the API key is configured', () => {
  const env = { ...completeEnv, ANTHROPIC_MODEL: '' };
  const report = buildReadinessReport(env, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker',
  }]), '22.16.0');

  assert.equal(report.checks.find(item => item.id === 'reasoning')?.status, 'ready');
  assert.equal(report.blockers.includes('reasoning'), false);
});

test('Attendee readiness accepts an authorized internal owner without a durable speaker UUID', () => {
  const env = { ...completeEnv, AUTHORIZED_ACTOR_IDS: 'lead' };
  const report = buildReadinessReport(env, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead',
  }]), '22.16.0');

  assert.equal(report.checks.find(item => item.id === 'attendee')?.status, 'ready');
});

test('readiness returns actionable blockers for the current MVP requirements', () => {
  const report = buildReadinessReport({
    NOGITA_ADMIN_TOKEN: 'short', BOARD_PROVIDER: 'demo', REPO_PROVIDER: 'demo',
    MEETING_PROVIDER: 'attendee', ATTENDEE_API_KEY: 'present', ATTENDEE_PRIVACY_REVIEWED: 'false',
    NOGITA_MODE: 'demo',
  }, new IdentityDirectory([]), '22.12.0');
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ['runtime', 'admin_auth', 'durable_queue', 'slack', 'jira', 'github', 'attendee', 'reasoning']);
  assert.ok(report.checks.every(check => !check.detail.includes('present')));
});

test('readiness accepts explicitly public GitHub repositories without a token', () => {
  const publicRepository = {
    ...completeEnv,
    GITHUB_TOKEN: '',
    GITHUB_PUBLIC_REPO: 'true',
  };
  const report = buildReadinessReport(publicRepository, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker',
  }]), '22.16.0');
  assert.equal(report.checks.find(item => item.id === 'github')?.status, 'ready');
});

test('readiness mirrors the HTTP admin token startup gate without exposing the token', () => {
  for (const value of ['', 'too-short', 'replace-with-long-random-local-token']) {
    const report = buildReadinessReport({ ...completeEnv, NOGITA_ADMIN_TOKEN: value },
      new IdentityDirectory([{ id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker' }]), '22.16.0');
    assert.equal(report.checks.find(item => item.id === 'admin_auth')?.status, 'blocked');
    assert.ok(report.blockers.includes('admin_auth'));
    if (value) assert.equal(JSON.stringify(report).includes(value), false);
  }
});

test('Slack readiness accepts either Socket Mode or signed Events API configuration', () => {
  const signedEvents = { ...completeEnv, SLACK_APP_TOKEN: '', SLACK_SIGNING_SECRET: 'signing-secret' };
  const report = buildReadinessReport(signedEvents, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker',
  }]), '22.16.0');
  assert.equal(report.checks.find(item => item.id === 'slack')?.status, 'ready');
});

test('Slack readiness rejects nonempty values that are not usable Slack tokens', () => {
  const invalidTokens = { ...completeEnv, SLACK_APP_TOKEN: 'not-an-app-token', SLACK_BOT_TOKEN: 'not-a-bot-token' };
  const report = buildReadinessReport(invalidTokens, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker',
  }]), '22.16.0');
  assert.equal(report.checks.find(item => item.id === 'slack')?.status, 'blocked');
});

test('readiness surfaces strict adapter construction failures without exposing the error', () => {
  const report = buildReadinessReport(completeEnv, new IdentityDirectory([{
    id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker',
  }]), '22.16.0', false);
  assert.deepEqual(report.blockers, ['provider_config']);
  assert.equal(JSON.stringify(report).includes('jira-secret'), false);
});

test('readiness blocks production when the durable queue encryption key is missing or malformed', () => {
  for (const value of ['', 'not-base64', 'c2hvcnQ=']) {
    const report = buildReadinessReport({ ...completeEnv, NOGITA_QUEUE_ENCRYPTION_KEY: value },
      new IdentityDirectory([{ id: 'lead', displayName: 'Lead', attendeeUserUuid: 'speaker' }]), '22.16.0');
    assert.equal(report.checks.find(item => item.id === 'durable_queue')?.status, 'blocked');
    if (value) assert.equal(JSON.stringify(report).includes(value), false);
  }
});
