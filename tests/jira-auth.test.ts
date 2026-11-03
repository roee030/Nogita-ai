import test from 'node:test';
import assert from 'node:assert/strict';
import { JiraAuthError, JiraBoard } from '../src/adapters/jira.ts';
import { withLiveJira, type ReadinessReport } from '../src/app/readiness.ts';

/**
 * What Jira really answered an expired API token (reproduced 2026-11-03): searches 200 with no issues (anonymous),
 * creates 400 "the project doesn't exist or you don't have permission", and /myself 401.
 */
function anonymousJira(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/search/jql')) return json(200, { issues: [] });
    if (path.endsWith('/myself')) return json(401, { message: 'Client must be authenticated to access this resource.' });
    if (path.endsWith('/rest/api/3/issue')) return json(400, { errorMessages: ["The target project doesn't exist or you don't have permission to create issues in it."] });
    return json(404, {});
  }) as typeof fetch;
}
const config = (authCheck: boolean) => ({ baseUrl: 'https://nogita.atlassian.net', email: 'a@b.c', token: 'expired', projectKey: 'KAN', issueType: 'Task', authCheck });

test('NOGITA_JIRA_AUTH_CHECK: an expired token is a broken connection, not an empty board', async () => {
  const calls: string[] = [];
  const board = new JiraBoard(config(true), anonymousJira(calls));
  await assert.rejects(board.searchTasks({}), (error: unknown) => error instanceof JiraAuthError && /renew JIRA_API_TOKEN/.test(error.message)
    && /do not say the board is empty/.test(error.message));
  await assert.rejects(board.createTask({ title: 'test', description: 'just for test', requestId: 'r1' }), JiraAuthError);
  assert.ok(calls.some(path => path.endsWith('/myself')));
});

test('without the flag the old behavior stays: empty results and a plain HTTP error', async () => {
  const board = new JiraBoard(config(false), anonymousJira([]));
  assert.deepEqual(await board.searchTasks({}), []);
  await assert.rejects(board.createTask({ title: 'test', description: 'd', requestId: 'r1' }), /Jira create failed: HTTP 400/);
});

test('a working token with a really empty board stays empty, and /myself is asked once per five minutes', async () => {
  const calls: string[] = [];
  const working = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    return new Response(JSON.stringify(path.endsWith('/myself') ? { accountId: 'x' } : { issues: [] }), { status: 200 });
  }) as typeof fetch;
  const board = new JiraBoard(config(true), working);
  assert.deepEqual(await board.searchTasks({}), []);
  assert.deepEqual(await board.searchTasks({}), []);
  assert.equal(calls.filter(path => path.endsWith('/myself')).length, 1);
});

test('readiness: a Jira that is configured but rejects the token is blocked', () => {
  const report: ReadinessReport = { ok: true, blockers: [], checks: [{ id: 'jira', status: 'ready', detail: 'configured' }] } as ReadinessReport;
  const blocked = withLiveJira(report, { provider: 'jira', status: 'failed', httpStatus: 404 });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ['jira']);
  assert.match(blocked.checks[0]!.detail, /renew JIRA_API_TOKEN/);
  assert.equal(withLiveJira(report, { provider: 'jira', status: 'connected', httpStatus: 200 }), report);
});
