import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityDirectory, parseIdentityRecords } from '../src/core/identity.ts';
import { createDependencies } from '../src/app/config.ts';

const records = [
  {
    id: 'roee',
    displayName: 'Roee Angel',
    slack: { teamId: 'T123', userId: 'U123' },
    jiraAccountId: 'jira-roee',
    githubUsername: 'roee030',
    attendeeUserUuid: 'meet-roee',
  },
  {
    id: 'qa-user',
    displayName: 'QA User',
    slack: { teamId: 'T123', userId: 'U456' },
    jiraAccountId: 'jira-qa',
    githubUsername: 'nogita-qa',
  },
];

test('one internal identity resolves from Slack, Jira, and GitHub identifiers', () => {
  const directory = new IdentityDirectory(records);
  assert.equal(directory.fromSlack('T123', 'U123')?.id, 'roee');
  assert.equal(directory.fromJira('jira-roee')?.id, 'roee');
  assert.equal(directory.fromGitHub('ROEE030')?.id, 'roee');
  assert.equal(directory.fromAttendee('meet-roee')?.id, 'roee');
  assert.equal(directory.fromId('roee')?.displayName, 'Roee Angel');
  assert.equal(directory.jiraAccountIdFor('roee'), 'jira-roee');
});

test('unknown and cross-workspace users do not resolve', () => {
  const directory = new IdentityDirectory(records);
  assert.equal(directory.fromSlack('OTHER', 'U123'), undefined);
  assert.equal(directory.fromSlack('T123', 'UNKNOWN'), undefined);
  assert.equal(directory.fromJira('unknown'), undefined);
  assert.equal(directory.fromGitHub('unknown'), undefined);
});

test('duplicate provider identifiers are rejected', () => {
  assert.throws(() => new IdentityDirectory([...records, {
    id: 'duplicate', displayName: 'Duplicate',
    slack: { teamId: 'T123', userId: 'U123' },
  }]), /duplicate Slack identity/);
});

test('identity records parse from local JSON configuration', () => {
  assert.deepEqual(parseIdentityRecords(JSON.stringify(records)), records);
  assert.throws(() => parseIdentityRecords('{bad json'), /invalid identity map/i);
});

test('application dependencies load the local identity map', () => {
  const previous = process.env.IDENTITY_MAP_JSON;
  process.env.IDENTITY_MAP_JSON = JSON.stringify(records);
  try {
    const dependencies = createDependencies();
    assert.equal(dependencies.identities.fromGitHub('roee030')?.id, 'roee');
  } finally {
    if (previous === undefined) delete process.env.IDENTITY_MAP_JSON;
    else process.env.IDENTITY_MAP_JSON = previous;
  }
});
