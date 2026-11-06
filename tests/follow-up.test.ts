import test from 'node:test';
import assert from 'node:assert/strict';
import { followUp, type OwnTask } from '../src/core/follow-up.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { JiraBoard } from '../src/adapters/jira.ts';

const now = Date.parse('2026-11-05T09:00:00Z');
const day = 86_400_000;
const task = (key: string, title: string, done: boolean, updatedDaysAgo: number, assignee?: string): OwnTask =>
  ({ key, title, done, status: done ? 'Done' : 'In Progress', created: now - 3 * day, updated: now - updatedDaysAgo * day,
    ...(assignee ? { assignee } : {}), url: `https://nogita.atlassian.net/browse/${key}` });

test('done, moving and stuck, stuck first and unowned called out', () => {
  const text = followUp([task('KAN-24', 'Summarize merged PRs', true, 1), task('KAN-31', 'Release notes', false, 0.5, 'Dana'),
    task('KAN-32', 'Cache headers', false, 3)], now)!;
  assert.match(text, /^Follow-up on the 3 tasks I opened recently: 1 done, 1 moving, 1 stuck\./);
  assert.match(text, /Stuck \(no change for 2 days or more\):\n- KAN-32 Cache headers \(In Progress\) .*untouched 3 days, and nobody owns it/);
  assert.ok(text.indexOf('Stuck') < text.indexOf('Moving') && text.indexOf('Moving') < text.indexOf('Done'));
  assert.equal(followUp([], now), undefined);
});

class Meeting extends DemoMeeting {
  readonly chat: string[] = [];
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
}

test('NOGITA_FOLLOW_UP: posted once, on the first words heard, because the provider refuses chat from the lobby', async () => {
  const board = Object.assign(new DemoBoard(), { ownRecentTasks: async () => [task('KAN-32', 'Cache headers', false, 3)] });
  const actor = { id: 'roee', displayName: 'Roee', verified: true };
  for (const followUpOn of [true, false]) {
    const m = new Meeting('m');
    const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set()) },
      { schedule: () => 0, cancel: () => undefined, followUp: followUpOn, now: () => now });
    const id = `s-${followUpOn}`;
    await engine.startSession(id, m);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(m.chat.length, 0, 'nothing while she may still be in the lobby');
    await engine.onUtterance(id, { text: 'Good morning everyone.', eventId: '1', actor });
    await engine.onUtterance(id, { text: 'Let us start.', eventId: '2', actor });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(m.chat.filter(text => text.startsWith('Follow-up on the 1 task')).length, followUpOn ? 1 : 0);
  }
});

test('Jira: only tasks with her request property count, with their status category', async () => {
  const http = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path.endsWith('/search/jql')) return json(200, { issues: [
      { key: 'KAN-24', fields: { summary: 'Summarize merged PRs', status: { name: 'Done', statusCategory: { key: 'done' } }, created: '2026-11-01T15:14:00Z', updated: '2026-11-02T10:00:00Z' } },
      { key: 'KAN-25', fields: { summary: 'Made by a person', status: { name: 'To Do', statusCategory: { key: 'new' } }, created: '2026-11-01T16:00:00Z', updated: '2026-11-01T16:00:00Z' } }] });
    if (path.includes('/KAN-24/properties/')) return json(200, { value: { digest: 'x' } });
    return json(404, {});
  }) as typeof fetch;
  const board = new JiraBoard({ baseUrl: 'https://nogita.atlassian.net', email: 'a@b.c', token: 't', projectKey: 'KAN', issueType: 'Task' }, http);
  const own = await board.ownRecentTasks(7);
  assert.deepEqual(own.map(t => [t.key, t.done]), [['KAN-24', true]]);
});
