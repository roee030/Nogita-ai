import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityDirectory, parseIdentityRecords } from '../src/core/identity.ts';
import { JiraBoard } from '../src/adapters/jira.ts';
import { buildDependencies } from '../src/app/config.ts';
import { parseTenantConfig } from '../src/app/tenant-config.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { jiraFake } from './conformance/jira-fake.ts';

const team = [{ accountId: 'acc-dana', displayName: 'Dana Katz', email: 'dana@acme.example' },
  { accountId: 'acc-omer', displayName: 'Omer Levi', email: 'omer@acme.example' }];

function jira(people: IdentityDirectory, fetcher = jiraFake(team)) {
  return new JiraBoard({ baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.example', token: 't', projectKey: 'WEB', issueType: 'Task',
    resolveAssigneeId: id => people.accountFor(id, 'web', 'jira'), resolveAssigneeEmail: id => people.emailFor(id) }, fetcher);
}

test('people: email and per-board accounts are parsed, normalized and must be unique', () => {
  const [dana] = parseIdentityRecords(JSON.stringify([{ id: 'dana', displayName: 'Dana Katz', email: ' Dana@Acme.Example ',
    accounts: { ops: 'ops-7' } }]));
  assert.equal(dana!.email, 'dana@acme.example');
  const people = new IdentityDirectory([dana!]);
  assert.equal(people.fromEmail('DANA@acme.example')?.id, 'dana');
  assert.equal(people.accountFor('dana', 'ops', 'memory'), 'ops-7');
  assert.equal(people.accountFor('dana', 'web', 'jira'), undefined);
  assert.throws(() => parseIdentityRecords(JSON.stringify([{ id: 'a', displayName: 'A', email: 'not-an-email' }])), /record 0 email/);
  assert.throws(() => parseIdentityRecords(JSON.stringify([{ id: 'a', displayName: 'A', accounts: ['x'] }])), /record 0 accounts/);
  assert.throws(() => new IdentityDirectory([{ id: 'a', displayName: 'A', email: 'x@y.z' }, { id: 'b', displayName: 'B', email: 'x@y.z' }]),
    /duplicate email/);
});

test('people: someone with only an email can be named and assigned; the board finds their account by it', async () => {
  const people = new IdentityDirectory([{ id: 'dana', displayName: 'Dana Katz', email: 'dana@acme.example' },
    { id: 'guest', displayName: 'Guest Person' }]);
  assert.deepEqual(people.findByName('dana'), [{ id: 'dana', displayName: 'Dana Katz' }]);
  assert.deepEqual(people.findByName('guest'), [], 'no email and no account: no board can find them');
  assert.equal(people.displayNameFor('dana'), 'Dana Katz');
  const calls: string[] = [];
  const fake = jiraFake(team);
  const board = jira(people, (async (input, init) => { calls.push(String(input)); return fake(input, init); }) as typeof fetch);
  await board.createTask({ title: 'Fix cache', description: '', requestId: 'r1', assigneeId: 'dana' });
  await board.createTask({ title: 'Fix login', description: '', requestId: 'r2', assigneeId: 'dana' });
  const mine = await board.searchTasks({ assigneeId: 'dana' });
  assert.deepEqual(mine.map(task => task.assignee), ['Dana Katz', 'Dana Katz']);
  assert.equal(calls.filter(url => url.includes('assignable/search')).length, 1, 'the account is looked up once');
});

test('people: an email the board does not single out assigns nobody', async () => {
  const people = new IdentityDirectory([{ id: 'noa', displayName: 'Noa Bar', email: 'noa@acme.example' }]);
  await assert.rejects(() => jira(people).createTask({ title: 'x', description: '', requestId: 'r', assigneeId: 'noa' }), /allowlist/);
});

test('people: in a company config, "assign it to me" works from an email alone, on the board the task goes to', async () => {
  const config = parseTenantConfig(JSON.stringify({ tenant: { id: 'acme' },
    boards: [{ id: 'web', provider: 'jira', baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.example', token: 'env:T', projectKey: 'WEB' }],
    people: [{ id: 'dana', displayName: 'Dana Katz', email: 'dana@acme.example' }], authorizedActorIds: ['dana'] }), { T: 'x' });
  const deps = buildDependencies(config);
  const board = jira(deps.people);
  const { toolbox } = buildToolbox({ actor: { id: 'dana', displayName: 'Dana Katz', verified: true }, request: 'Nogita, open a task for the cache and assign it to me',
    sessionId: 's', eventId: 'e', policy: new AllowlistPolicy(new Set(['dana'])), code: new DemoCode(), board, people: deps.people,
    onReceipt: async () => {}, completed: new Map() });
  const result = await toolbox.run('create_task', { title: 'Cache file reads', description: 'From the meeting', assignee: 'me' });
  assert.match(result.content, /WEB-1/);
  assert.deepEqual((await board.searchTasks({ assigneeId: 'dana' })).map(task => task.assignee), ['Dana Katz']);
});
