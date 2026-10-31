import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentContent, type AgentToolbox, type ChatModel, type ChatModelRequest,
  type ChatModelResponse, type ToolOutcome } from '../src/core/agent.ts';
import { EvidenceLedger, linkSources, tagSources } from '../src/core/evidence.ts';

/** Results in the shapes the toolbox returns them. */
const RESULTS: Record<string, string> = {
  repo_activity: ['acme/app, live branch main, 2026-10-31T00:00:00+02:00 to 2026-10-31T23:59:59+02:00.',
    '1 commit(s), 1 merged pull request(s).', '', 'Merged pull requests:',
    '- #41 Retry worker backoff (dana, merged 2026-10-31T10:00:00Z) https://github.com/acme/app/pull/41',
    '', 'Commits (newest first):',
    '- abc1234 Add backoff to the retry worker (dana, 2026-10-31T09:00:00Z) https://github.com/acme/app/commit/abc1234def5678'].join('\n'),
  read_file: 'src/core/retry.ts (lines 10-40 of 300)\nhttps://github.com/acme/app/blob/main/src/core/retry.ts\n10: export function backoff() {',
  ci_status: ['acme/app, CI for branch main, read live.', '', 'Runs (newest first):',
    '- CI: failure on abc1234 (main), push https://github.com/acme/app/actions/runs/9001',
    '  failed job: test, at step "npm test" https://github.com/acme/app/actions/runs/9001/job/77'].join('\n'),
  get_task: 'KAN-12: Retry worker drops jobs\nStatus: In Progress\nLink: https://acme.atlassian.net/browse/KAN-12',
  search_messages: '[2026-10-31T10:00:00Z] #dev dana: the retry fix is out https://acme.slack.com/archives/C1/p1730000000',
  read_channel: '[2026-10-31T10:00:00Z] dana: deploy at noon',
  list_files: 'src/core/retry.ts\nsrc/core/agent.ts',
};

test('each kind of source is read from the result text', () => {
  const ledger = new EvidenceLedger();
  for (const [tool, content] of Object.entries(RESULTS)) {
    ledger.record(tool, tool === 'read_channel' ? { channel: 'dev' } : tool === 'list_files' ? { prefix: 'src/core' } : {}, content, 0);
  }
  assert.deepEqual(ledger.list().map(source => [source.id, source.kind, source.label]), [
    ['S1', 'pull_request', 'PR #41'],
    ['S2', 'commit', 'commit abc1234'],
    ['S3', 'file', 'src/core/retry.ts:10-40'],
    ['S4', 'ci_run', 'CI run 9001'],
    ['S5', 'ci_run', 'CI job 77'],
    ['S6', 'issue', 'KAN-12'],
    ['S7', 'message', 'Slack message'],
    ['S8', 'message', '#dev messages'],
    ['S9', 'api', 'list_files prefix=src/core'],
  ]);
  const commit = ledger.get('S2')!;
  assert.equal(commit.url, 'https://github.com/acme/app/commit/abc1234def5678');
  assert.match(commit.title!, /^abc1234 Add backoff to the retry worker/);
  assert.equal(commit.tool, 'repo_activity');
});

test('a source seen again keeps its id; a task line with an unknown link is an issue', () => {
  const ledger = new EvidenceLedger();
  ledger.record('repo_activity', {}, RESULTS.repo_activity!, 0);
  const again = ledger.record('recent_commits', {}, '[1] commit abc1234\nhttps://github.com/acme/app/commit/abc1234def5678\nAdd backoff', 1);
  assert.deepEqual(again.map(source => source.id), ['S2']);
  assert.equal(ledger.size, 2);
  const [task] = ledger.record('search_tasks', {}, 'NOG-7 [To Do] Fix login (unassigned) https://linear.app/acme/issue/nog7', 1);
  assert.deepEqual([task!.kind, task!.label], ['issue', 'NOG-7']);
});

test('one result adds at most 40 sources', () => {
  const ledger = new EvidenceLedger();
  const many = Array.from({ length: 100 }, (_, i) => `- ${i} https://github.com/acme/app/commit/${(0xabc0000 + i).toString(16)}`).join('\n');
  assert.equal(ledger.record('repo_activity', {}, many, 0).length, 40);
});

test('tagging puts each id after its link, and heads a result without links with its source', () => {
  const ledger = new EvidenceLedger();
  const tagged = tagSources(RESULTS.ci_status!, ledger.record('ci_status', {}, RESULTS.ci_status!, 0));
  assert.match(tagged, /actions\/runs\/9001 \[S1\]\n/);
  assert.match(tagged, /runs\/9001\/job\/77 \[S2\]$/);
  const bare = tagSources(RESULTS.read_channel!, ledger.record('read_channel', { channel: '#dev' }, RESULTS.read_channel!, 0));
  assert.match(bare, /^\[Source S3: #dev messages\]\n\[2026/);
});

test('linking numbers the cited sources in order and lists them; unknown marks are dropped', () => {
  const ledger = new EvidenceLedger();
  ledger.record('repo_activity', {}, RESULTS.repo_activity!, 0);
  ledger.record('read_file', { path: 'src/core/retry.ts' }, RESULTS.read_file!, 1);
  const { text, cited } = linkSources('Backoff landed in PR #41 [S1] and lives in retry.ts [S3, S1]. It works [S9].', ledger);
  assert.deepEqual(cited, ['S1', 'S3']);
  assert.equal(text, 'Backoff landed in PR #41 [1] and lives in retry.ts [2, 1]. It works.\n\nSources:\n' +
    '[1] PR #41 https://github.com/acme/app/pull/41\n[2] src/core/retry.ts:10-40 https://github.com/acme/app/blob/main/src/core/retry.ts');
  // An answer that cites nothing still links to what it rested on.
  assert.match(linkSources('Backoff landed today.', ledger).text, /^Backoff landed today\.\n\nSources:\n\[1\] PR #41 .*\n\[2\] commit abc1234 .*\n\[3\] src\/core\/retry\.ts/);
  assert.equal(linkSources('Nothing to see.', new EvidenceLedger()).text, 'Nothing to see.');
});

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    this.requests.push({ ...request, messages: request.messages.slice() });
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = step.text ? [{ type: 'text', text: step.text }] : [];
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}
const toolbox: AgentToolbox = {
  specs: [...Object.keys(RESULTS), 'broken'].map(name => ({ name, description: '', input_schema: { type: 'object' } })),
  isWrite: () => false,
  run: async (name): Promise<ToolOutcome> => name === 'broken'
    ? { content: 'GitHub said 500 https://github.com/acme/app/pull/99', isError: true } : { content: RESULTS[name] ?? '' },
};
const resultsOf = (request: ChatModelRequest) => {
  const last = request.messages.at(-1)!.content;
  return typeof last === 'string' ? [] : last.filter(block => block.type === 'tool_result').map(block => (block as { content: string }).content);
};
const steps = (answer: string): Step[] => [
  { tools: [{ name: 'repo_activity', input: { period: 'today' } }, { name: 'broken', input: {} }] },
  { tools: [{ name: 'ci_status', input: {} }] },
  { text: answer },
];

test('off by default: results are not tagged and there is no ledger', async () => {
  const model = new ScriptedModel(steps('PR #41 landed [S1].'));
  const result = await runAgent(model, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox, messages: [{ role: 'user', content: 'what landed today?' }] });
  assert.equal(result.evidence, undefined);
  assert.equal(result.answer, 'PR #41 landed [S1].');
  assert.doesNotMatch(resultsOf(model.requests[1]!)[0]!, /\[S1\]/);
  assert.equal(model.requests[2]!.turnSystem, 'turn');
});

test('on, in chat: results are tagged, the model is told to cite, and the answer links its sources', async () => {
  const model = new ScriptedModel(steps('PR #41 landed today [S1], but CI on main failed in the test job [S4].'));
  const result = await runAgent(model, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox, evidenceLedger: true,
    messages: [{ role: 'user', content: 'what landed today, and is CI green?' }] });
  assert.equal(model.requests[0]!.turnSystem, 'turn');
  assert.match(model.requests[1]!.turnSystem, /Tool results mark their sources as \[S1\]/);
  const [activity, broken] = resultsOf(model.requests[1]!);
  assert.match(activity!, /pull\/41 \[S1\]/);
  // A failed call is not a source.
  assert.doesNotMatch(broken!, /\[S/);
  assert.deepEqual(result.evidence!.sources.map(source => `${source.id} ${source.label} step ${source.step}`),
    ['S1 PR #41 step 0', 'S2 commit abc1234 step 0', 'S3 CI run 9001 step 1', 'S4 CI job 77 step 1']);
  assert.deepEqual(result.evidence!.cited, ['S1', 'S4']);
  assert.equal(result.answer, 'PR #41 landed today [1], but CI on main failed in the test job [2].\n\nSources:\n' +
    '[1] PR #41 https://github.com/acme/app/pull/41\n[2] CI job 77 https://github.com/acme/app/actions/runs/9001/job/77');
});

test('on, in a voice turn: the ledger is kept, but nothing is tagged or added to what is spoken', async () => {
  const model = new ScriptedModel(steps('PR forty-one landed today.'));
  const spoken: string[] = [];
  const result = await runAgent(model, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox, evidenceLedger: true,
    onSpeech: text => spoken.push(text), messages: [{ role: 'user', content: 'what landed today?' }] });
  assert.doesNotMatch(resultsOf(model.requests[1]!)[0]!, /\[S1\]/);
  assert.equal(model.requests[2]!.turnSystem, 'turn');
  assert.equal(result.answer, 'PR forty-one landed today.');
  assert.deepEqual(spoken, ['PR forty-one landed today.']);
  assert.equal(result.evidence!.sources.length, 4);
  assert.deepEqual(result.evidence!.cited, []);
});
