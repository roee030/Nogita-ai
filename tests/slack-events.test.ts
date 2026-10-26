import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackRequest } from '../src/app/slack-event.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const teams = new Set(['T123']);
const common = { team_id: 'T123', event_id: 'Ev123',
  event: { type: 'app_mention', user: 'U123', channel: 'C123', ts: '123.456',
    text: '<@U999> create a task for onboarding' } };
test('mention creates a Slack-scoped verified, addressed request in the original thread', () => {
  const parsed = parseSlackRequest(common, teams, 'U999');
  assert.equal(parsed?.sessionId, 'slack:T123:C123:123.456');
  assert.equal(parsed?.utterance.actor.id, 'unmapped:slack:T123:U123');
  assert.equal(parsed?.utterance.actor.verified, false);
  assert.equal(parsed?.utterance.text, 'Nogita, create a task for onboarding');
});
test('known Slack user is represented by the shared internal identity', () => {
  const identities = new IdentityDirectory([{
    id: 'roee', displayName: 'Roee Angel',
    slack: { teamId: 'T123', userId: 'U123' },
    jiraAccountId: 'jira-roee', githubUsername: 'roee030',
  }]);
  const parsed = parseSlackRequest(common, teams, 'U999', identities);
  assert.equal(parsed?.utterance.actor.id, 'roee');
  assert.equal(parsed?.utterance.actor.displayName, 'Roee Angel');
  assert.equal(parsed?.utterance.actor.verified, true);
});
test('unmapped Slack user is never a verified actor', () => {
  const identities = new IdentityDirectory([]);
  const parsed = parseSlackRequest(common, teams, 'U999', identities);
  assert.equal(parsed?.utterance.actor.verified, false);
});
test('cross-workspace events and bot replies are ignored', () => {
  assert.equal(parseSlackRequest({ ...common, team_id: 'OTHER' }, teams, 'U999'), null);
  assert.equal(parseSlackRequest({ ...common, event: { ...common.event, bot_id:'B123' } }, teams, 'U999'), null);
});
test('DM must address Nogita by name; replies use originating thread', () => {
  const event = { ...common.event, type:'message', channel_type:'im', channel:'D123', text:'Nogita, hello', thread_ts:'100.000' };
  assert.equal(parseSlackRequest({ ...common, event }, teams, 'U999')?.threadTs, '100.000');
  assert.equal(parseSlackRequest({ ...common, event:{ ...event,text:'hello' } }, teams, 'U999'),null);
});
