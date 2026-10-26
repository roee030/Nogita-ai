import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadinessReport } from '../src/app/readiness.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const completeEnv: NodeJS.ProcessEnv = {
  NOGITA_ADMIN_TOKEN: 'admin-secret-that-is-long-enough',
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

test('readiness returns actionable blockers for the current MVP requirements', () => {
  const report = buildReadinessReport({
    NOGITA_ADMIN_TOKEN: 'short', BOARD_PROVIDER: 'demo', REPO_PROVIDER: 'demo',
    MEETING_PROVIDER: 'attendee', ATTENDEE_API_KEY: 'present', ATTENDEE_PRIVACY_REVIEWED: 'false',
    NOGITA_MODE: 'demo',
  }, new IdentityDirectory([]), '22.12.0');
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ['runtime', 'slack', 'jira', 'github', 'attendee', 'reasoning']);
  assert.ok(report.checks.every(check => !check.detail.includes('present')));
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
