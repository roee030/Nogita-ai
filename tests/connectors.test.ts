import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../src/adapters/slack.ts';
import { JiraBoard, adfParagraph } from '../src/adapters/jira.ts';
import { MondayBoard } from '../src/adapters/monday.ts';
import { GitHubCode } from '../src/adapters/github.ts';
import { RecallMeeting } from '../src/adapters/recall.ts';

const issue = { title: 'Fix auth tokens', description: 'Check SameSite and CSRF settings', requestId: 'id-1' };
test('Slack signatures: valid HMAC, tamper/replay refused', () => {
  const secret = 'test-secret'; const now = 1_700_000_000;
  const body = '{"type":"url_verification","challenge":"xyz"}';
  const signature = `v0=${createHmac('sha256',secret).update(`v0:${now}:${body}`).digest('hex')}`;
  assert.equal(verifySlackSignature(secret, String(now), signature, body, now), true);
  assert.equal(verifySlackSignature(secret, String(now), signature, `${body} `, now), false);
  assert.equal(verifySlackSignature(secret, String(now), signature, body, now + 500), false);
});
test('Jira Cloud issue body contains ADF and no guessed assignee', async () => {
  let request: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = async (_url, options) => {
    request = JSON.parse(String(options?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ key: 'NG-42' }), { status: 201 });
  };
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task' }, mockFetch);
  const receipt = await jira.createTask(issue);
  assert.equal(receipt.url, 'https://sample.atlassian.net/browse/NG-42');
  const fields = request?.fields as Record<string,unknown>;
  assert.deepEqual(fields.description, adfParagraph(issue.description));
  assert.equal(fields.assignee, undefined);
});
test('Jira rejects unknown assignee before network call', async () => {
  const jira = new JiraBoard({ baseUrl: 'https://sample.atlassian.net', email: 'user@example.com',
    token: 'test-token', projectKey: 'NG', issueType: 'Task', allowedAssigneeIds: new Set(['trusted']) });
  await assert.rejects(() => jira.createTask({ ...issue, assigneeId: 'unknown' }), /allowlist/);
});
test('Monday GraphQL returns verified item link, never guesses assignment', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({
    data: { create_item: { id: '123', url: 'https://example.monday.com/boards/7/pulses/123' } } }), { status: 200 });
  const monday = new MondayBoard('dev-token', 7, 'text_description', mockFetch);
  assert.equal((await monday.createTask(issue)).kind, 'task');
  await assert.rejects(() => monday.createTask({ ...issue, assigneeId: 'person1' }), /mapping/);
});
test('GitHub source lookup only shows discovered relevant source files', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [
      { path: 'src/auth.ts', type: 'blob', size: 100 },
      { path: 'node_modules/auth.ts', type: 'blob', size: 100 },
      { path: 'src/payment.ts', type: 'blob', size: 100 },
    ] }));
    if (u.includes('/contents/src/auth.ts')) return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from('export function auth() { return true; }').toString('base64'),
    }));
    throw new Error(`unexpected path ${u}`);
  };
  const git = new GitHubCode({ token: 'test', owner: 'example', repo: 'app', ref: 'main' }, fakeFetch);
  const out = await git.findEvidence('auth');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, 'src/auth.ts');
  assert.match(out[0]?.url ?? '', /github.com\/example\/app/);
});
test('Recall joins only approved host; sends actual chat receipt API request', async () => {
  const calls: Array<{url: string;body:unknown}> = [];
  const mockFetch: typeof fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(String(opts?.body)) });
    return new Response(JSON.stringify({id:'2b3c4d5e-1234-4567-8899-123456789abc'}), { status: 200 });
  };
  const recall = new RecallMeeting('m', 'secret', 'us-east-1', mockFetch);
  await assert.rejects(() => recall.join('https://meet.google.com.attacker.invalid/abc'), /allowlist/);
  await recall.join('https://meet.google.com/abc-defg-hij');
  await recall.sendCompletion({ provider: 'jira', kind: 'task', label: 'NG-42', url: 'https://sample.atlassian.net/browse/NG-42' });
  assert.equal(calls.length,2);
  assert.match(calls[1]!.url, /send_chat_message/);
  assert.deepEqual(calls[1]!.body, { to: 'everyone', message: 'NG-42: https://sample.atlassian.net/browse/NG-42' });
  assert.equal(await recall.raiseHand(), false);
  await assert.rejects(() => recall.speak('hi'), /not wired/);
});
