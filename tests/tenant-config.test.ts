import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDependencies, createDependencies } from '../src/app/config.ts';
import { parseTenantConfig, tenantConfigFromEnv } from '../src/app/tenant-config.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import { JiraBoard } from '../src/adapters/jira.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { MultiBoard, MultiCode } from '../src/adapters/multi.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';
import type { BoardPort, TaskSearch } from '../src/core/contracts.ts';

const file = (value: unknown) => JSON.stringify(value);
const acme = {
  tenant: { id: 'acme', name: 'Acme' },
  boards: [
    { id: 'web', provider: 'jira', baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.example', token: 'env:ACME_JIRA_TOKEN', projectKey: 'WEB' },
    { id: 'ops', provider: 'demo', default: true },
  ],
  repositories: [{ id: 'shop', provider: 'github', owner: 'acme', repo: 'shop', token: 'env:ACME_GITHUB_TOKEN' }, { id: 'demo', provider: 'demo' }],
  people: [{ id: 'dana', displayName: 'Dana Katz', jiraAccountId: 'acc-dana' }],
  authorizedActorIds: ['dana'],
};
const secrets = { ACME_JIRA_TOKEN: 'jira-secret', ACME_GITHUB_TOKEN: 'gh-secret' };

test('tenant config file: secrets come from the environment by reference, never from the file', () => {
  const config = parseTenantConfig(file(acme), secrets);
  const web = config.boards[0]!;
  assert.equal(web.provider === 'jira' && web.token, 'jira-secret');
  assert.equal(config.repositories[0]!.provider === 'github' && config.repositories[0]!.token, 'gh-secret');
  assert.equal(config.ai.mode, 'demo');
  assert.deepEqual(config.authorizedActorIds, ['dana']);
});

test('tenant config file: mistakes name the field, never a secret value', () => {
  assert.throws(() => parseTenantConfig(file(acme), {}), /boards\[0\]\.token: environment variable ACME_JIRA_TOKEN is not set/);
  assert.throws(() => parseTenantConfig(file({ ...acme, tenant: { id: 'Acme Corp' } }), secrets), /tenant\.id/);
  assert.throws(() => parseTenantConfig(file({ ...acme, boards: [{ id: 'x', provider: 'trello' }] }), secrets), /boards\[0\]\.provider: unknown board provider "trello"/);
  assert.throws(() => parseTenantConfig(file({ ...acme, boards: [{ id: 'a', provider: 'demo' }, { id: 'a', provider: 'demo' }] }), secrets), /duplicate id "a"/);
  assert.throws(() => parseTenantConfig(file({ ...acme, boards: [{ id: 'a', provider: 'demo', default: true }, { id: 'b', provider: 'demo', default: true }] }), secrets), /only one board/);
  assert.throws(() => parseTenantConfig('{', secrets), /not valid JSON/);
  try { parseTenantConfig(file({ ...acme, boards: [{ ...acme.boards[0], baseUrl: 7 }] }), secrets); }
  catch (error) { assert.doesNotMatch(String(error), /jira-secret/); }
});

test('several connections become one board and one repository; a single one is used as it is', () => {
  const deps = buildDependencies(parseTenantConfig(file(acme), secrets));
  assert.ok(deps.board instanceof MultiBoard);
  assert.deepEqual(deps.board.boards?.map(item => item.id), ['web', 'ops']);
  assert.ok(deps.code instanceof MultiCode);
  assert.equal(deps.tenant.id, 'acme');
  const single = buildDependencies(parseTenantConfig(file({ ...acme, boards: [acme.boards[0]], repositories: [] }), secrets));
  assert.ok(single.board instanceof JiraBoard);
  assert.ok(single.code instanceof DemoCode);
});

test('the environment still configures a single company exactly as before', () => {
  const env = { BOARD_PROVIDER: 'jira', JIRA_BASE_URL: 'https://t.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'x',
    JIRA_PROJECT_KEY: 'KAN', JIRA_READ_PROJECT_KEYS: 'OPS, WEB', AUTHORIZED_ACTOR_IDS: 'roee, dana' };
  const config = tenantConfigFromEnv(env);
  assert.equal(config.tenant.id, 'default');
  assert.deepEqual(config.authorizedActorIds, ['roee', 'dana']);
  assert.deepEqual(config.boards[0]!.provider === 'jira' && config.boards[0]!.readProjectKeys, ['OPS', 'WEB']);
  assert.ok(createDependencies(env).board instanceof JiraBoard);
  assert.ok(createDependencies({}).board instanceof DemoBoard);
});

function tools(board: BoardPort) {
  return buildToolbox({ actor: { id: 'dana', displayName: 'Dana Katz', verified: true }, request: 'Nogita, open a task for the cache',
    sessionId: 's', eventId: 'e', policy: new AllowlistPolicy(new Set(['dana'])), code: new DemoCode(), board,
    people: new IdentityDirectory([{ id: 'dana', displayName: 'Dana Katz', jiraAccountId: 'acc-dana' }]), onReceipt: async () => {}, completed: new Map() }).toolbox;
}

test('agent: one search for every board: words, status and "me"; JQL is offered only to a Jira board', async () => {
  const seen: TaskSearch[] = [];
  const board = new MemoryBoard('memory', 'MEM', new Map([['dana', 'Dana Katz']]));
  const original = board.searchTasks.bind(board);
  board.searchTasks = async query => { seen.push(query); return original(query); };
  const box = tools(board);
  const spec = box.specs.find(item => item.name === 'search_tasks')!;
  assert.ok(!('jql' in (spec.input_schema.properties as object)));
  assert.ok(!('board' in (spec.input_schema.properties as object)));
  await box.run('search_tasks', { status: 'In Progress', assignee: 'me' });
  assert.deepEqual(seen.at(-1), { text: undefined, status: 'In Progress', assigneeId: 'dana', limit: undefined });
  await box.run('search_tasks', { unassigned: true, assignee: 'me' });
  assert.equal(seen.at(-1)?.unassigned, true);
  assert.equal(seen.at(-1)?.assigneeId, undefined);
  const jira = tools(new JiraBoard({ baseUrl: 'https://t.atlassian.net', email: 'a@b.c', token: 'x', projectKey: 'KAN', issueType: 'Task' }));
  assert.ok('jql' in (jira.specs.find(item => item.name === 'search_tasks')!.input_schema.properties as object));
});

test('agent: with several boards a task can go to the board they named', async () => {
  const web = new MemoryBoard('memory', 'WEB'); const ops = new MemoryBoard('memory', 'OPS');
  const box = tools(new MultiBoard([{ id: 'web', board: web }, { id: 'ops', board: ops }]));
  const create = box.specs.find(item => item.name === 'create_task')!;
  assert.deepEqual((create.input_schema.properties as Record<string, { enum?: string[] }>).board?.enum, ['web', 'ops']);
  const result = await box.run('create_task', { title: 'Cache file reads', description: 'From the meeting', board: 'ops' });
  assert.match(result.content, /OPS-1/);
  assert.equal(web.tasks.length, 0);
});

test('the example tenant config in config/ is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../config/tenant.example.json', import.meta.url), 'utf8');
  const config = parseTenantConfig(raw, { ANTHROPIC_API_KEY: 'k', ACME_JIRA_TOKEN: 'j', ACME_MONDAY_TOKEN: 'm', ACME_GITHUB_TOKEN: 'g',
    ACME_SLACK_BOT_TOKEN: 'xoxb-1' });
  assert.deepEqual(config.boards.map(board => board.id), ['web', 'marketing']);
  assert.deepEqual(config.repositories.map(repo => repo.id), ['shop', 'mobile']);
});

test('a cell can be given its company config inline, and readiness checks what that config connected', async () => {
  const { loadTenantConfig } = await import('../src/app/tenant-config.ts');
  const { buildReadinessReport } = await import('../src/app/readiness.ts');
  const env = { NOGITA_TENANT_CONFIG: file(acme), ...secrets };
  assert.equal(loadTenantConfig(env).tenant.id, 'acme');
  const deps = createDependencies(env);
  assert.deepEqual(deps.connections, { boards: ['jira', 'demo'], repositories: ['github', 'demo'], authorizedActorIds: ['dana'] });
  const report = buildReadinessReport(env, deps.identities, '22.16.0', true, false, deps.connections);
  assert.equal(report.checks.find(item => item.id === 'jira')?.status, 'ready');
  assert.equal(report.checks.find(item => item.id === 'github')?.status, 'ready');
  assert.throws(() => createDependencies({ ...env, NOGITA_TENANT_CONFIG: file({ ...acme, boards: [{ ...acme.boards[0], token: 'broker:web' }] }) }),
    /needs NOGITA_BROKER_URL/);
});
