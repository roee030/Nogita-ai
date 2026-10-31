import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentContent, type AgentToolbox, type ChatModel, type ChatModelRequest,
  type ChatModelResponse, type ToolOutcome } from '../src/core/agent.ts';
import { digestResult, MORE_OF_RESULT, resultPage } from '../src/core/result-digest.ts';

const authors = ['dana', 'roee', 'moshe'];
/** A week of activity in the shape `repo_activity` returns, long enough to be past the 14,000-character cut. */
function activity(commits: number): string {
  const lines = ['acme/app, live branch main, 2026-10-25T00:00:00+02:00 to 2026-10-31T23:59:59+02:00.',
    `${commits} commit(s), 2 merged pull request(s).`, '', 'Merged pull requests:',
    '- #41 Retry worker backoff (dana, merged 2026-10-30T10:00:00Z) https://github.com/acme/app/pull/41',
    '  Adds exponential backoff to the retry worker.',
    '- #42 Session budget (roee, merged 2026-10-31T09:00:00Z) https://github.com/acme/app/pull/42', '', 'Commits (newest first):'];
  for (let i = 0; i < commits; i++) {
    lines.push(`- ${(0xabc0000 + i).toString(16)} Change number ${i} to the meeting engine and its tests ` +
      `(${authors[i % 3]}, 2026-10-${String(31 - (i % 7)).padStart(2, '0')}T10:00:00Z) https://github.com/acme/app/commit/${i}`);
  }
  lines.push('', 'Files: 40 changed, +900 -300. Most changed:', '- src/core/engine.ts (modified, +200 -50)', '- tests/engine.test.ts (modified, +120 -10)');
  return lines.join('\n');
}

test('a large activity result keeps every section, its count and its groups, within the budget', () => {
  const text = activity(200);
  assert.ok(text.length > 14_000);
  const digest = digestResult(text, 'r1');
  assert.ok(digest.length <= 6_000, `digest is ${digest.length} characters`);
  assert.match(digest, /^\[Large result r1: \d+ characters, \d+ lines, shown as a digest\. Call more_of_result with id "r1"/);
  // The header lines are kept as they are.
  assert.match(digest, /200 commit\(s\), 2 merged pull request\(s\)\./);
  assert.match(digest, /Merged pull requests: 2 items; by author: dana 1, roee 1\./);
  assert.match(digest, /Commits \(newest first\): 200 items; by author: dana 67, roee 67, moshe 66\./);
  // The last section is not starved by the long one before it.
  assert.match(digest, /Files: 40 changed, \+900 -300\. Most changed: 2 items; by change: modified 2\./);
  assert.match(digest, /src\/core\/engine\.ts/);
  // The newest commits are shown, and the rest is named with where it starts.
  assert.match(digest, /abc0000 Change number 0/);
  const more = /\.\.\. (\d+) more items from offset (\d+)/.exec(digest)!;
  assert.ok(more, digest);
  const offset = Number(more[2]);
  assert.match(text.slice(offset), new RegExp(`^- [0-9a-f]+ Change number ${200 - Number(more[1])} `));
});

test('a task list is grouped by status', () => {
  const statuses = ['To Do', 'In Progress', 'Done'];
  const text = Array.from({ length: 400 }, (_, i) => `NOG-${i + 1} [${statuses[i % 3]}] Task number ${i + 1} about the meeting bot (dana)`).join('\n');
  const digest = digestResult(text, 'r2');
  assert.match(digest, /Items: 400 items; by status: To Do 134, Done 133, In Progress 133\./);
  assert.match(digest, /NOG-1 \[To Do\]/);
});

test('slack messages are grouped by channel; code search matches are counted by block', () => {
  const slack = Array.from({ length: 300 }, (_, i) =>
    `[2026-10-31T10:${String(i % 60).padStart(2, '0')}:00Z] #${i % 4 ? 'dev' : 'ops'} dana: message ${i} about the deploy and the retry worker`).join('\n');
  assert.match(digestResult(slack, 'r1'), /Items: 300 items; by channel: #dev 225, #ops 75\./);
  const evidence = Array.from({ length: 60 }, (_, i) =>
    `[${i + 1}] src/file${i}.ts\nhttps://github.com/acme/app/blob/main/src/file${i}.ts\n${'const x = 1;\n'.repeat(20)}`).join('\n---\n');
  const digest = digestResult(evidence, 'r1');
  assert.match(digest, /Matches: 60 items\./);
  assert.match(digest, /\[1\] src\/file0\.ts/);
});

test('plain text (a long file or patch) shows its first lines and where the rest starts', () => {
  const text = Array.from({ length: 2_000 }, (_, i) => `line ${i} of a long generated file with some content`).join('\n');
  const digest = digestResult(text, 'r1');
  assert.ok(digest.length <= 6_000);
  assert.match(digest, /line 0 of a long/);
  assert.match(digest, /\.\.\. \d+ more lines from offset \d+/);
});

test('a page starts at a line boundary, ends on one, and says where to continue', () => {
  const text = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n');
  const first = resultPage(text, 'r1', 0, 50);
  assert.match(first, /^\[r1, characters 0-\d+ of \d+\]\nrow 0\n/);
  const next = Number(/continues from offset (\d+)/.exec(first)![1]);
  assert.equal(text[next - 1], '\n');
  // An offset in the middle of a line starts at that line.
  assert.match(resultPage(text, 'r1', text.indexOf('row 42') + 3), /\nrow 42\n/);
  assert.match(resultPage(text, 'r1', text.indexOf('row 99')), /row 99\n\[End of r1\.\]$/);
  assert.match(resultPage(text, 'r1', 10_000), /past the end/);
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

const big = activity(200);
const toolbox: AgentToolbox = {
  specs: [{ name: 'repo_activity', description: '', input_schema: { type: 'object' } },
    { name: 'broken', description: '', input_schema: { type: 'object' } }],
  isWrite: () => false,
  run: async (name): Promise<ToolOutcome> => name === 'broken' ? { content: `x${'y'.repeat(20_000)}`, isError: true }
    : { content: name === 'repo_activity' ? big : 'small' },
};
const resultsOf = (request: ChatModelRequest) => {
  const last = request.messages.at(-1)!.content;
  return typeof last === 'string' ? [] : last.filter(block => block.type === 'tool_result').map(block => (block as { content: string }).content);
};
const run = (steps: Step[], digestResults?: boolean) => {
  const model = new ScriptedModel(steps);
  return runAgent(model, { stableSystem: '', turnSystem: '', stream: false, toolbox, messages: [{ role: 'user', content: 'what landed this week?' }],
    ...(digestResults ? { digestResults } : {}) }).then(result => ({ result, model }));
};

test('off by default: a large result is still cut at 14,000 characters and there is no more_of_result', async () => {
  const { model } = await run([{ tools: [{ name: 'repo_activity', input: {} }] }, { text: 'Done.' }]);
  assert.ok(!model.requests[0]!.tools.some(tool => tool.name === MORE_OF_RESULT));
  assert.match(resultsOf(model.requests[1]!)[0]!, /\[truncated: \d+ more characters\]$/);
});

test('on: the model gets the digest and reads the rest with more_of_result', async () => {
  const { result, model } = await run([
    { tools: [{ name: 'repo_activity', input: {} }] },
    { tools: [{ name: MORE_OF_RESULT, input: { id: 'r1', offset: 14_000 } }, { name: MORE_OF_RESULT, input: { id: 'r9' } }] },
    { text: 'Two hundred commits landed.' },
  ], true);
  assert.ok(model.requests[0]!.tools.some(tool => tool.name === MORE_OF_RESULT));
  const [digest] = resultsOf(model.requests[1]!);
  assert.match(digest!, /^\[Large result r1: /);
  assert.match(digest!, /Commits \(newest first\): 200 items/);
  const [page, missing] = model.requests[2]!.messages.at(-1)!.content as Array<{ content: string; is_error?: boolean }>;
  const start = (text: string) => Number(/characters (\d+)-/.exec(text)![1]);
  assert.ok(start(page!.content) <= 14_000 && start(page!.content) > 13_500);
  assert.ok(big.includes(page!.content.split('\n').slice(1, -1).join('\n')));
  assert.equal(missing!.is_error, true);
  assert.match(missing!.content, /No large result "r9" in this turn; there is r1\./);
  assert.equal(result.answer, 'Two hundred commits landed.');
  assert.deepEqual(result.toolCalls, ['repo_activity', MORE_OF_RESULT, MORE_OF_RESULT]);
});

test('on: small results and errors are passed as before', async () => {
  const { model } = await run([{ tools: [{ name: 'other', input: {} }, { name: 'broken', input: {} }] }, { text: 'Done.' }], true);
  const [small, broken] = resultsOf(model.requests[1]!);
  assert.equal(small, 'small');
  assert.match(broken!, /\[truncated: \d+ more characters\]$/);
});
