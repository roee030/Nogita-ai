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

test('the set has 80 cases with unique ids: the two live failures, 2 to 10 actions, an unknown owner, retries, research and missions', () => {
  assert.equal(CASES.length, 80);
  assert.equal(new Set(CASES.map(item => item.id)).size, 80);
  const groups = (group: EvalCase['group']) => CASES.filter(item => item.group === group).length;
  assert.deepEqual([groups('research'), groups('cross_source'), groups('ci'), groups('missions')], [12, 10, 8, 10]);
  const missions = CASES.filter(item => item.missions);
  assert.ok(missions.some(item => item.restartAfter !== undefined) && missions.some(item => item.chatAfter !== undefined));
  assert.ok(missions.some(item => item.turns.length >= 3));
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
    ['gives the size of the day or several of its themes', 'counts match the day', 'only names pull requests merged today',
      'every claim has a source in the ledger']);
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
  assert.deepEqual(summary.claims, { total: 0, backed: 0, share: 1 });
});

test('the summary gives the share of claims backed by a source', () => {
  const score = (claims: { total: number; backed: number }) => ({ id: 'a', group: 'research', passed: true, ms: 1, checks: [],
    claims: { ...claims, unbacked: [] } });
  assert.deepEqual(summarize([score({ total: 6, backed: 6 }), score({ total: 4, backed: 3 })]).claims, { total: 10, backed: 9, share: 0.9 });
});

test('every tool result the model is given lands in the ledger, and claims it backs pass', async () => {
  const item = byId('research-pr-files');
  const run = await runCase(new ScriptedModel([
    { tools: [{ name: 'get_change', input: { pr: 15 } }] },
    { text: 'PR 15 touched src/core/agent.ts, src/core/engine.ts, tests/agent.test.ts and docs/TASK_BOARD.md.' }]), item);
  assert.ok(run.sources.some(source => source.kind === 'pull_request' && source.label === 'PR #15' && source.tool === 'get_change'));
  const score = scoreCase(item, run);
  assert.deepEqual(failed(score), []);
  assert.equal(score.claims?.total, 4);
  assert.equal(score.claims?.backed, 4);
});

test('a claim no source backs fails the case: a pull request, commit or file she never read', async () => {
  const item = byId('research-commit-detail');
  const answer = async (text: string, tools = [{ name: 'get_change', input: { sha: 'af72c53' } }]) =>
    scoreCase(item, await runCase(new ScriptedModel([{ tools }, { text }]), item));
  // The commit she was asked about is the person's own words, not her claim.
  assert.deepEqual(failed(await answer('Commit af72c53 added repo_activity and get_change for the team\'s time zone.')), []);
  const unread = await answer('It added repo_activity, like PR 31 and commit 1234abcd did, in src/core/missions.ts.');
  assert.deepEqual(failed(unread), ['every claim has a source in the ledger']);
  assert.deepEqual(unread.claims?.unbacked, ['pull_request 31', 'commit 1234abcd', 'file missions.ts']);
  // A failed lookup is no source.
  const missing = await answer('It is PR 20.', [{ name: 'get_change', input: { sha: 'fffffff' } }]);
  assert.ok(failed(missing).includes('every claim has a source in the ledger'));
});

test('a task key from a create_task result is backed, and receipt lines are not claims', async () => {
  const item = byId('two-tasks');
  const score = scoreCase(item, await runCase(new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'CSV export of action items', description: 'Export.' } },
      { name: 'create_task', input: { title: 'Password reset email', description: 'Email.' } }] },
    { text: 'Done: KAN-7 and KAN-8. KAN-99 too.' }]), item));
  assert.deepEqual(score.claims?.unbacked, ['issue KAN-99']);
});

test('a question across Jira, Slack and the repo: all three read and the state right passes; one source short fails', async () => {
  const item = byId('cross-version-endpoint');
  const answer = async (tools: Step['tools'], text: string) => scoreCase(item, await runCase(new ScriptedModel([{ tools }, { text }]), item));
  const all = [{ name: 'get_task', input: { key: 'KAN-6' } }, { name: 'search_messages', input: { query: 'version endpoint' } },
    { name: 'search_code', input: { query: 'version endpoint' } }];
  assert.deepEqual(failed(await answer(all, 'KAN-6 is in review with Yossi; Slack says the release checklist needs it. Nothing is merged yet.')), []);
  assert.deepEqual(failed(await answer(all.slice(0, 1), 'KAN-6 is in review; the release checklist needs it.')), ['read all three']);
});

test('CI: the recorded runs and deployment answer for main, a pull request and a commit', async () => {
  const { code } = evalWorld({});
  const main = (await code.ciStatus!({}))!;
  assert.equal(main.runs[0]!.conclusion, 'success');
  assert.deepEqual([main.deployment?.sha.slice(0, 7), main.deployment?.notDeployed], ['d2e58f7', 5]);
  assert.equal((await code.ciStatus!({ pr: 21 }))!.runs[0]!.failedJobs?.[0]?.name, 'typecheck');
  assert.equal((await code.ciStatus!({ pr: 99 })), undefined);
  assert.equal((await code.ciStatus!({ sha: '356ec23' }))!.runs[0]!.conclusion, 'failure');
  assert.deepEqual((await code.ciStatus!({ branch: 'feature/sso' }))!.runs, []);
});

test('a CI question answered without reading CI: honest is no fabrication, a made-up result is', async () => {
  const item = byId('ci-main');
  const answer = async (text: string) => scoreCase(item, await runCase(new ScriptedModel([{ text }]), item));
  assert.deepEqual(failed(await answer('I can\'t see CI from here.')), ['read CI', 'yes, the latest run passed']);
  assert.deepEqual(failed(await answer('Yes, main is green.')), ['read CI', 'gives no CI result without reading CI']);
});

/** Conversation turns and mission rounds each play their own script. */
class MissionScriptModel implements ChatModel {
  readonly agentModel = 'scripted';
  private readonly scripts: { conversation: ScriptedModel; mission: ScriptedModel };
  constructor(conversation: Step[], mission: Step[]) { this.scripts = { conversation: new ScriptedModel(conversation), mission: new ScriptedModel(mission) }; }
  streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    return this.scripts[request.usageContext?.startsWith('mission:') ? 'mission' : 'conversation'].streamChat(request, onText);
  }
}

test('a mission waiting for approval survives a restart; approved after it, the task is opened once', async () => {
  const item = byId('mission-approve-after-restart');
  const run = await runCase(new MissionScriptModel([
    { tools: [{ name: 'delegate_mission', input: { goal: 'Open a task to document turn taking v2 in the voice lab README (KAN-3).' } }] },
    { text: 'On it.' },
    { tools: [{ name: 'decide_mission', input: { decision: 'approve' } }] },
    { text: 'Approved, opening it.' },
  ], [
    { tools: [{ name: 'get_task', input: { key: 'KAN-3' } }] },
    { tools: [{ name: 'create_task', input: { title: 'Document turn taking v2 in the voice lab README', description: 'From KAN-3.' } }] },
    { tools: [{ name: 'finish_mission', input: { summary: 'Opened KAN-7.', evidence: ['KAN-7'] } }] },
  ]), item);
  assert.equal(run.turns[0]!.tasksAfter, 6, 'nothing written before the approval');
  assert.equal(run.missions?.[0]?.status, 'done');
  assert.deepEqual(failed(scoreCase(item, run)), []);
});

test('"what\'s left?" asked in a chat thread after the meeting is answered from the mission store', async () => {
  const item = byId('mission-status-other-channel');
  const run = await runCase(new MissionScriptModel([
    { tools: [{ name: 'delegate_mission', input: { goal: 'Check whether the version endpoint (KAN-6) is merged.' } }] },
    { text: 'On it.' },
    { tools: [{ name: 'mission_status', input: {} }] },
    { text: 'KAN-6 is in review with Yossi, not merged yet.' },
  ], [
    { tools: [{ name: 'get_task', input: { key: 'KAN-6' } }] },
    { tools: [{ name: 'finish_mission', input: { summary: 'KAN-6 is in review with Yossi, not merged yet.', evidence: ['KAN-6'] } }] },
  ]), item);
  assert.deepEqual(run.tools.filter(tool => tool === 'mission_status'), ['mission_status']);
  assert.match(JSON.stringify(run.evidence), /M-\w+ \[done\]/);
  assert.deepEqual(failed(scoreCase(item, run)), []);
  // Without mission_status the same answer fails the source check.
  const guessed = await runCase(new MissionScriptModel([
    { tools: [{ name: 'delegate_mission', input: { goal: 'Check KAN-6.' } }] }, { text: 'On it.' }, { text: 'It is merged.' },
  ], [{ tools: [{ name: 'finish_mission', input: { summary: 'Done.', evidence: [] } }] }]), item);
  assert.ok(failed(scoreCase(item, guessed)).includes('answered "what\'s left" from the mission store'));
});
