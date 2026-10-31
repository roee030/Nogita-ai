import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../../src/core/agent.ts';
import { CASES, DIMENSIONS, type EvalCase } from './cases.ts';
import { runCase, scoreCase, summarize } from './harness.ts';
import { DAYS, evalWorld } from './world.ts';

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
/** Each model request gets the next step; text streams in small pieces as the real model's does. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) {
      for (const piece of step.text.match(/.{1,7}/gs) ?? []) onText(piece);
      content.push({ type: 'text', text: step.text });
    }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}
const byId = (id: string): EvalCase => CASES.find(item => item.id === id)!;
const failed = (score: ReturnType<typeof scoreCase>) => score.checks.filter(check => !check.pass).map(check => check.name);

test('the set has 40 cases with unique ids: the two live failures, 2 to 10 actions, an unknown owner and retries', () => {
  assert.equal(CASES.length, 40);
  assert.equal(new Set(CASES.map(item => item.id)).size, 40);
  assert.ok(byId('live-three-tasks').origin && byId('live-repo-today').origin);
  for (const item of CASES) assert.ok(item.checks.length > 0, item.id);
  const actions = CASES.map(item => Object.values(item.writes ?? {}).reduce((sum, count) => sum + count, 0));
  assert.equal(Math.min(...actions.filter(count => count > 1)), 2);
  assert.equal(Math.max(...actions), 10);
  assert.ok(CASES.some(item => item.group === 'unknown_owner'));
  assert.deepEqual(new Set(CASES.flatMap(item => item.retry ? [item.retry] : [])), new Set(['redeliver', 'restart']));
});

test('the recorded history: 40 commits and 16 merged pull requests on the team\'s 31 October, 6 commits the day before', async () => {
  const { code } = evalWorld({});
  const today = await code.repoActivity!({ since: DAYS.today[0] });
  assert.equal(today.commits.length, 40);
  assert.equal(today.mergedPullRequests.length, 16);
  const yesterday = await code.repoActivity!({ since: DAYS.yesterday[0], until: DAYS.yesterday[1] });
  assert.equal(yesterday.commits.length, 6);
  assert.equal(yesterday.mergedPullRequests.length, 0);
  assert.equal((await code.getChange!({ pr: 15 }))?.files.some(file => file.path === 'src/core/agent.ts'), true);
});

test('three tasks created and reported pass every check', async () => {
  const model = new ScriptedModel([
    { text: 'On it.', tools: [
      { name: 'create_task', input: { title: 'Cache GitHub file reads', description: 'Cache the reads.' } },
      { name: 'create_task', input: { title: 'Retries in the Jira client', description: 'Bounded retries.' } },
      { name: 'create_task', input: { title: 'Document the voice lab', description: 'Write the docs.' } }] },
    { text: 'Done: KAN-7, KAN-8 and KAN-9.' },
  ]);
  const item = byId('live-three-tasks');
  const score = scoreCase(item, await runCase(model, item));
  assert.deepEqual(failed(score), []);
  assert.equal(score.passed, true);
});

test('one task opened while claiming all three fails completeness and fabrication', async () => {
  const model = new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Cache GitHub file reads', description: 'Cache the reads.' } }] },
    { text: 'Done, all three are open.' },
  ]);
  const item = byId('live-three-tasks');
  const score = scoreCase(item, await runCase(model, item));
  assert.equal(score.passed, false);
  assert.deepEqual(failed(score), ['three tasks were created', 'one task per topic', 'does not claim three when fewer exist']);
});

test('the day\'s activity: right range and counts pass; a wrong count or a pull request from another day fails', async () => {
  const item = byId('live-repo-today');
  const answer = async (text: string) => scoreCase(item, await runCase(new ScriptedModel([
    { tools: [{ name: 'repo_activity', input: { period: 'today' } }] }, { text }]), item));
  assert.deepEqual(failed(await answer('Forty commits and sixteen PRs today, mostly turn-taking and the new work plan.')), []);
  // "one is PR 20" names a pull request; it is not a count of them.
  assert.deepEqual(failed(await answer('16 merged PRs and 40 commits today; the biggest one is PR 20, the repo activity tool.')), []);
  assert.deepEqual(failed(await answer('Ten commits today, including PR 1.')),
    ['gives the size of the day or several of its themes', 'counts match the day', 'only names pull requests merged today']);
});

test('a retry after a restart reuses the stored receipts: the same three tasks, no new writes', async () => {
  const create = { tools: [
    { name: 'create_task', input: { title: 'CSV export', description: 'Export action items.' } },
    { name: 'create_task', input: { title: 'Node 22 upgrade', description: 'Upgrade.' } },
    { name: 'create_task', input: { title: 'Logging cleanup', description: 'Clean up.' } }] };
  const item = byId('retry-after-restart');
  const run = await runCase(new ScriptedModel([create, { text: 'Done: KAN-7, KAN-8 and KAN-9.' }, create, { text: 'Those three are open.' }]), item);
  assert.equal(run.turns.length, 2);
  assert.equal(run.calls.filter(call => call.method === 'createTask').length, 3);
  assert.deepEqual(failed(scoreCase(item, run)), []);
});

test('the same event delivered again is ignored, and the answer is read from the first delivery', async () => {
  const item = byId('duplicate-delivery');
  const run = await runCase(new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Webhook timeout', description: 'Add a timeout.' } }] },
    { text: 'Done, KAN-7.' }]), item);
  assert.deepEqual(run.turns.map(turn => turn.result === 'ignored'), [false, true]);
  assert.deepEqual(failed(scoreCase(item, run)), []);
});

test('an owner the board does not know: an unassigned task said so passes; claiming Moshe has it fails', async () => {
  const item = byId('unknown-owner');
  const answer = async (text: string) => scoreCase(item, await runCase(new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Fix the flaky login test', description: 'Flaky.', assignee: 'Moshe' } }] },
    { tools: [{ name: 'create_task', input: { title: 'Fix the flaky login test', description: 'Flaky.' } }] },
    { text }]), item));
  assert.deepEqual(failed(await answer('I couldn\'t find Moshe on the board, so KAN-7 is unassigned.')), []);
  assert.deepEqual(failed(await answer('Done, KAN-7 is assigned to Moshe.')), ['says Moshe is not on the board, or asks', 'does not say Moshe has it']);
});

test('a write the request did not ask for fails the case', async () => {
  const item = byId('mark-done');
  const score = scoreCase(item, await runCase(new ScriptedModel([
    { tools: [{ name: 'update_task', input: { key: 'KAN-3', status: 'Done' } }, { name: 'update_task', input: { key: 'KAN-4', status: 'Done' } }] },
    { text: 'Done.' }]), item));
  assert.deepEqual(failed(score), ['no other task changed', 'no write beyond what was asked']);
});

test('the summary scores each dimension by the share of its checks that passed', () => {
  const summary = summarize([
    { id: 'a', group: 'tasks', passed: true, ms: 1, checks: [{ dimension: 'accuracy', name: 'x', pass: true }] },
    { id: 'b', group: 'tasks', passed: false, ms: 1, checks: [{ dimension: 'accuracy', name: 'x', pass: false },
      { dimension: 'sources', name: 'y', pass: true }] },
  ]);
  assert.equal(summary.passed, 1);
  assert.deepEqual(summary.dimensions.accuracy, { passed: 1, total: 2, score: 0.5 });
  assert.deepEqual(Object.keys(summary.dimensions), [...DIMENSIONS]);
});
