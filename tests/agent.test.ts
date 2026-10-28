import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { SpeechChunker, runAgent, type AgentContent, type ChatModel, type ChatModelRequest, type ChatModelResponse } from '../src/core/agent.ts';
import { buildToolbox, requestsChatPost, requestsTaskWrite } from '../src/core/agent-tools.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { AnthropicBrain } from '../src/adapters/anthropic.ts';
import { JiraBoard, adfToText } from '../src/adapters/jira.ts';
import { GitHubCode } from '../src/adapters/github.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { ActionReceipt, Capability, ChatPort, CodePort, Evidence } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const guest = { id: 'guest', displayName: 'Guest', verified: true };

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
/** Scripted model: each call returns the next step, streaming its text in small pieces. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[], private readonly failAt?: number) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(structuredClone(request));
    if (this.failAt === this.index) { this.index++; throw new Error('model down'); }
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) {
      for (const piece of step.text.match(/.{1,7}/gs) ?? []) onText(piece);
      content.push({ type: 'text', text: step.text });
    }
    for (const [n, tool] of (step.tools ?? []).entries()) {
      content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    }
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

class SlackLikeMeeting extends DemoMeeting {
  override readonly capabilities: ReadonlySet<Capability> = new Set(['chat_receipt']);
}
class RecordingMeeting extends DemoMeeting {
  readonly spoken: Array<{ text: string; mirror: boolean }> = [];
  override async speak(message: string, options: { chatMirror?: boolean } = {}): Promise<void> {
    this.spoken.push({ text: message, mirror: options.chatMirror !== false });
    await super.speak(message);
  }
}
const people = new IdentityDirectory([
  { id: 'lead', displayName: 'Lead Person', jiraAccountId: 'acc-lead' },
  { id: 'moshe-c', displayName: 'Moshe Cohen', jiraAccountId: 'acc-mc' },
  { id: 'moshe-l', displayName: 'Moshe Levi', jiraAccountId: 'acc-ml' },
  { id: 'dana', displayName: 'Dana Katz', jiraAccountId: 'acc-dana' },
]);

function fixture(model: ChatModel, options: { meeting?: DemoMeeting; code?: CodePort; chat?: ChatPort } = {}) {
  const meeting = options.meeting ?? new RecordingMeeting('m');
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: options.code ?? new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])), agent: model, people, chat: options.chat },
  { schedule: () => 0, cancel: () => undefined });
  const utter = (text: string, eventId: string, actor = lead) => engine.onUtterance('s', { text, eventId, actor });
  return { engine, meeting, board, utter };
}

test('speech chunker releases the first sentence at once and batches the rest', () => {
  const out: string[] = [];
  const chunker = new SpeechChunker(text => out.push(text), 40);
  for (const piece of 'Sure, it lives in engine.ts. It retries three times. Then it waits. Finally it gives up and logs it.'.match(/.{1,5}/gs)!) chunker.push(piece);
  assert.equal(out[0], 'Sure, it lives in engine.ts.');
  chunker.flush();
  assert.equal(out.join(' '), 'Sure, it lives in engine.ts. It retries three times. Then it waits. Finally it gives up and logs it.');
  assert.ok(out.length <= 3, `too many fragments: ${JSON.stringify(out)}`);
});

test('agent loop runs tools, feeds results back and separates the lead-in from the answer', async () => {
  const model = new ScriptedModel([
    { text: 'Let me check.', tools: [{ name: 'search_code', input: { query: 'retry' } }, { name: 'list_files', input: {} }] },
    { text: 'It retries three times.' },
  ]);
  const ran: string[] = [];
  const result = await runAgent(model, { stableSystem: 's', turnSystem: 't', stream: true, onSpeech: () => undefined,
    messages: [{ role: 'user', content: 'how?' }],
    toolbox: { specs: [], isWrite: () => false, run: async name => { ran.push(name); return { content: `${name} result` }; } } });
  assert.deepEqual(ran.sort(), ['list_files', 'search_code']);
  assert.equal(result.preface, 'Let me check.');
  assert.equal(result.answer, 'It retries three times.');
  const second = model.requests[1]!.messages.at(-1)!;
  assert.ok(Array.isArray(second.content) && second.content.every(block => block.type === 'tool_result'));
});

test('voice: lead-in and answer are spoken as they stream, chat gets the answer once with a code link', async () => {
  const model = new ScriptedModel([
    { text: 'Let me check the session code.', tools: [{ name: 'search_code', input: { query: 'session' } }] },
    { text: 'Sessions are validated in session.ts before a user is returned. Expired tokens are rejected.' },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how do sessions work?', '1'), 'completed');
  const meeting = f.meeting as RecordingMeeting;
  assert.equal(meeting.spoken[0]?.text, 'Let me check the session code.');
  assert.ok(meeting.spoken.every(item => item.mirror === false));
  assert.match(meeting.spoken.map(item => item.text).join(' '), /Sessions are validated in session\.ts/);
  const chats = meeting.events.filter(event => event.type === 'chat').map(event => event.text);
  assert.deepEqual(chats, [
    'Sessions are validated in session.ts before a user is returned. Expired tokens are rejected.',
    'Code reference: https://example.invalid/demo/src/auth/session.ts#L10',
  ]);
  assert.ok(model.requests[0]!.tools.some(tool => tool.name === 'create_task'));
  assert.match(model.requests[0]!.messages[0]!.content as string, /Lead says to you now:\nhow do sessions work\?/);
});

test('task for a named person is assigned through the identity map and its link posted', async () => {
  const model = new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Add retry limit', description: 'From the planning discussion.', assignee: 'Dana' } }] },
    { text: 'Done, I opened it for Dana.' },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, open a task for Dana about the retry limit', '1'), 'completed');
  assert.equal(f.board.tasks.length, 1);
  assert.equal(f.board.tasks[0]!.assigneeId, 'dana');
  assert.ok(f.meeting.events.some(event => event.type === 'chat' && event.text === 'DEMO-1: https://example.invalid/DEMO-1'));
});

test('ambiguous owner: Nogita asks, and the same speaker answers without saying her name', async () => {
  const model = new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Fix login', description: 'd', assignee: 'Moshe' } }] },
    { text: 'Which Moshe, Cohen or Levi?' },
    { tools: [{ name: 'create_task', input: { title: 'Fix login', description: 'd', assignee: 'Moshe Levi' } }] },
    { text: 'Opened it for Moshe Levi.' },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, create a task for Moshe to fix login', '1');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(await f.utter('Levi', '2'), 'completed');
  assert.equal(f.board.tasks.length, 1);
  assert.equal(f.board.tasks[0]!.assigneeId, 'moshe-l');
  assert.match(model.requests[2]!.messages[0]!.content as string, /Which Moshe, Cohen or Levi\?/);
});

test('a write the person did not ask for is refused even if the model tries', async () => {
  const model = new ScriptedModel([
    { tools: [{ name: 'create_task', input: { title: 'Rewrite auth', description: 'd' } }] },
    { text: 'I did not open anything.' },
  ]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, what do you think about our auth flow?', '1');
  assert.equal(f.board.tasks.length, 0);
  const result = (model.requests[1]!.messages.at(-1)!.content as AgentContent[])[0] as { content: string; is_error?: boolean };
  assert.equal(result.is_error, true);
  assert.match(result.content, /does not explicitly ask/);
});

test('an unauthorized speaker gets general answers but no project tools', async () => {
  const model = new ScriptedModel([{ text: 'Sure, rate limiting usually lives at the edge.' }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, where should rate limiting live?', '1', guest), 'answered');
  assert.deepEqual(model.requests[0]!.tools, []);
  assert.match(model.requests[0]!.turnSystem, /not authorized/);
});

test('model failure before saying anything falls back to the planner', async () => {
  const model = new ScriptedModel([], 0);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, hello there', '1'), 'answered');
  assert.ok(f.meeting.events.some(event => event.type === 'speak' && /I'm here/.test(event.text ?? '')));
});

test('text conversation (Slack thread) gets one complete reply and no spoken lead-in', async () => {
  const model = new ScriptedModel([
    { text: 'Let me check.', tools: [{ name: 'search_code', input: { query: 'auth' } }] },
    { text: 'Auth is in `session.ts`: tokens are validated before a user is returned.' },
  ]);
  const f = fixture(model, { meeting: new SlackLikeMeeting('slack') });
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how does auth work?', '1'), 'answered');
  const posts = f.meeting.events.filter(event => event.type === 'speak' || event.type === 'chat').map(event => event.text);
  assert.deepEqual(posts, ['Auth is in `session.ts`: tokens are validated before a user is returned.']);
});

test('follow-up that is not for Nogita gets silence', async () => {
  const model = new ScriptedModel([{ text: 'Do you want me to open a task for that?' }, { text: '' }]);
  const f = fixture(model);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, is the export job safe?', '1');
  const before = f.meeting.events.length;
  assert.equal(await f.utter('Anyway, lunch is at noon.', '2'), 'ignored');
  assert.equal(f.meeting.events.length, before);
});

test('explicit write detectors', () => {
  for (const text of ['open a task for Moshe', 'can you log a bug for this', 'add it to the backlog', 'create tickets for both'])
    assert.equal(requestsTaskWrite(text), true, text);
  for (const text of ['make a jira ticket for the export bug', 'put it in the backlog', 'can you open two tasks for Dana?',
    'please log a bug about the crash', 'write that up'])
    assert.equal(requestsTaskWrite(text), true, text);
  for (const text of ['what is the status of KAN-12?', 'how does the task runner work', 'prepare a PR',
    'what are the open issues?', "what's new in the backlog?", 'any open tasks for Dana?', "what's open in jira?",
    'show me the open issues on the board', 'did Dana open a ticket for that?'])
    assert.equal(requestsTaskWrite(text), false, text);
  assert.equal(requestsChatPost('post a summary in #dev'), true);
  assert.equal(requestsChatPost('tell the team in slack we shipped'), true);
  assert.equal(requestsChatPost('could you share this in the dev channel?'), true);
  for (const text of ['what did they say in #dev?', 'what did they post in #dev?', 'tell me what the team said in slack',
    "let's ask the team", 'did anyone message the channel?'])
    assert.equal(requestsChatPost(text), false, text);
});

test('Slack post tool goes only through an explicit request and returns the permalink', async () => {
  const posts: Array<{ channel: string; text: string }> = [];
  const chat: ChatPort = { name: 'slack', listChannels: async () => [{ id: 'C1', name: 'dev' }],
    readChannel: async () => [{ channel: 'dev', author: 'Dana', text: 'deploy at 5', at: '2026-10-28 10:00' }],
    postMessage: async (channel, text): Promise<ActionReceipt> => { posts.push({ channel, text }); return { provider: 'slack', kind: 'message', label: '#dev', url: 'https://slack.example/p1' }; } };
  const receipts: ActionReceipt[] = [];
  const make = (request: string) => buildToolbox({ actor: lead, request, sessionId: 's', eventId: 'e', policy: new AllowlistPolicy(new Set(['lead'])),
    code: new DemoCode(), board: new DemoBoard(), chat, completed: new Map(), onReceipt: async receipt => { receipts.push(receipt); } });
  const refused = await make('what is new in dev?').toolbox.run('post_message', { channel: '#dev', text: 'hi' });
  assert.equal(refused.isError, true);
  const posted = await make('post in #dev that the deploy moved').toolbox.run('post_message', { channel: '#dev', text: 'Deploy moved to 6.' });
  assert.match(posted.content, /https:\/\/slack\.example\/p1/);
  assert.deepEqual(posts, [{ channel: '#dev', text: 'Deploy moved to 6.' }]);
  assert.equal(receipts.length, 1);
  const read = await make('what is new?').toolbox.run('read_channel', { channel: 'dev' });
  assert.match(read.content, /Dana: deploy at 5/);
});

function sse(events: unknown[]): Response {
  const body = events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('Anthropic streaming parses text and tool calls, caches the prompt and records usage', async () => {
  let body: Record<string, unknown> = {};
  const brain = new AnthropicBrain('k', 'claude-haiku-5-5', async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'search_code', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"retry"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]);
  });
  brain.beginUsageSession('s');
  const deltas: string[] = [];
  const response = await brain.streamChat({ stableSystem: 'stable', turnSystem: 'turn', maxTokens: 100, usageContext: 's',
    messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'search_code', description: 'd', input_schema: { type: 'object' } }] },
  delta => deltas.push(delta));
  assert.equal(deltas.join(''), 'Let me check.');
  assert.deepEqual(response.content, [{ type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'tu1', name: 'search_code', input: { query: 'retry' } }]);
  assert.equal(response.stopReason, 'tool_use');
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.deepEqual((body.system as Array<Record<string, unknown>>)[0]!.cache_control, { type: 'ephemeral' });
  assert.deepEqual((body.tools as Array<Record<string, unknown>>)[0]!.cache_control, { type: 'ephemeral' });
  const usage = brain.usageFor('s');
  assert.equal(usage.inputTokens, 200);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.estimatedUsd, Number(((200 * 3 + 20 * 15) / 1_000_000).toFixed(6)));
});

test('Jira reads stay inside the configured projects and assignees come from Jira itself', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const board = new JiraBoard({ baseUrl: 'https://team.atlassian.net', email: 'a@b.c', token: 't', projectKey: 'KAN', issueType: 'Task' },
    async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? String(init.body) : undefined });
      if (u.includes('/user/assignable/search')) return new Response(JSON.stringify([
        { accountId: 'acc-1', displayName: 'Moshe Cohen', active: true }, { accountId: 'acc-2', displayName: 'Dana Katz', active: true }]));
      if (u.endsWith('/search/jql')) return new Response(JSON.stringify({ issues: [
        { key: 'KAN-7', fields: { summary: 'Fix login', status: { name: 'In Progress' }, assignee: { displayName: 'Dana Katz' } } }] }));
      if (u.includes('/issue/KAN-7')) return new Response(JSON.stringify({ key: 'KAN-7', fields: { summary: 'Fix login',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users get logged out.' }] }] },
        comment: { comments: [{ author: { displayName: 'Dana' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On it' }] }] } }] } } }));
      if (u.endsWith('/rest/api/3/issue')) return new Response(JSON.stringify({ key: 'KAN-8' }), { status: 201 });
      throw new Error(`unexpected ${u}`);
    });
  const found = await board.searchTasks({ text: 'login', jql: 'status = "In Progress"' });
  assert.equal(found[0]?.key, 'KAN-7');
  assert.match(calls[0]!.body!, /project in \(\\"KAN\\"\) AND \(status = \\"In Progress\\"\) AND text ~ \\"login\\"/);
  await assert.rejects(() => board.searchTasks({ jql: 'status = Done) OR (project = SECRET' }), /must not set the project/);
  const detail = await board.getTask('KAN-7');
  assert.equal(detail?.description, 'Users get logged out.');
  assert.equal(detail?.comments[0]?.text, 'On it');
  assert.equal(await board.getTask('OTHER-1'), undefined);
  const people = await board.findAssignees('Moshe');
  assert.deepEqual(people, [{ id: 'jira:acc-1', displayName: 'Moshe Cohen' }]);
  await board.createTask({ title: 't', description: 'd', assigneeId: 'jira:acc-1', requestId: 'r1' });
  const created = JSON.parse(calls.at(-1)!.body!) as { fields: { assignee?: { accountId: string } } };
  assert.equal(created.fields.assignee?.accountId, 'acc-1');
  await assert.rejects(() => board.createTask({ title: 't', description: 'd', assigneeId: 'jira:never-seen', requestId: 'r2' }), /allowlist/);
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }).trim(), '- a');
});

function tarGz(files: Array<{ path: string; content: string }>): Buffer {
  const entries = files.map(item => {
    const body = Buffer.from(item.content);
    const header = Buffer.alloc(512);
    header.write(`example-app-commit/${item.path}`, 0, 'utf8');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
function advertisement(sha: string): Buffer {
  const packet = (payload: string) => `${(Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0')}${payload}`;
  return Buffer.from(`${packet('# service=git-upload-pack\n')}0000${packet(`${sha} refs/heads/main\0multi_ack\n`)}0000`);
}

test('GitHub agent access: read a file by suffix with numbered lines, list files, and a repository map', async () => {
  const sha = 'c'.repeat(40);
  const archive = tarGz([
    { path: 'src/retry/worker.ts', content: 'export const attempts = 3;\nexport function backoff(n: number) {\n  return 2 ** n;\n}\n' },
    { path: 'README.md', content: '# Example\nPayments service.' },
    { path: 'src/index.ts', content: 'export {};' },
  ]);
  const git = new GitHubCode({ publicRepo: true, owner: 'example', repo: 'app', ref: 'main' }, async url => {
    const u = String(url);
    if (u.endsWith('/info/refs?service=git-upload-pack')) return new Response(new Uint8Array(advertisement(sha)),
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    if (u === `https://codeload.github.com/example/app/tar.gz/${sha}`) return new Response(new Uint8Array(archive));
    throw new Error(`unexpected ${u}`);
  });
  const file = await git.readFile('worker.ts', 2, 3);
  assert.equal(file?.path, 'src/retry/worker.ts');
  assert.equal(file?.text, '2: export function backoff(n: number) {\n3:   return 2 ** n;');
  assert.equal(file?.url, `https://github.com/example/app/blob/${sha}/src/retry/worker.ts#L2-L3`);
  assert.equal(await git.readFile('missing.ts'), undefined);
  assert.deepEqual(await git.listFiles('src/'), ['src/index.ts', 'src/retry/worker.ts']);
  const overview = await git.overview();
  assert.deepEqual(overview.paths, ['README.md', 'src/index.ts', 'src/retry/worker.ts']);
  assert.match(overview.readme ?? '', /Payments service/);
});

test('the repository map reaches the agent prompt for authorized speakers', async () => {
  const code: CodePort = { name: 'github', findEvidence: async (): Promise<Evidence[]> => [],
    overview: async () => ({ paths: ['src/a.ts', 'src/b.ts'], readme: 'Readme text' }) };
  const model = new ScriptedModel([{ text: 'Two files.' }]);
  const f = fixture(model, { code });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, what is in the repo?', '1');
  assert.match(model.requests[0]!.stableSystem, /src\/a\.ts\nsrc\/b\.ts/);
  assert.match(model.requests[0]!.stableSystem, /Readme text/);
});

class AssessingBrain extends DemoBrain {
  calls = 0;
  async assessContribution(): Promise<{ raise: boolean; reason?: string; topic?: string }> {
    this.calls++;
    return { raise: true, topic: 'token storage', reason: 'They plan to store API tokens in plain text in the logs.' };
  }
}
class NoHandMeeting extends DemoMeeting {
  override readonly capabilities: ReadonlySet<Capability> = new Set(['listen', 'speak', 'chat_receipt']);
  override async raiseHand(): Promise<boolean> { return false; }
}
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

test('proactive: a critical miss raises a hand silently, and the reason reaches the agent when given the floor', async () => {
  const brain = new AssessingBrain();
  const model = new ScriptedModel([{ text: 'We should not log API tokens; they would end up in plain text.' }]);
  const meeting = new RecordingMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain,
    policy: new AllowlistPolicy(new Set(['lead'])), agent: model, people },
  { schedule: () => 0, cancel: () => undefined, assessmentIntervalMs: 0 });
  await engine.startSession('s', meeting);
  for (let i = 1; i <= 3; i++) await engine.onUtterance('s', { eventId: `u${i}`, actor: lead, text: `We log everything, step ${i}.` });
  await settle();
  assert.equal(brain.calls, 0, 'waits for a few utterances');
  await engine.onUtterance('s', { eventId: 'u4', actor: lead, text: 'Including the API tokens.' });
  await settle();
  assert.equal(brain.calls, 1);
  assert.equal(meeting.events.filter(e => e.type === 'raise_hand').length, 1);
  assert.equal(meeting.events.filter(e => e.type === 'speak' || e.type === 'chat').length, 0);
  await engine.onUtterance('s', { eventId: 'u5', actor: lead, text: 'Nogita, go ahead.' });
  assert.match(model.requests[0]!.turnSystem, /plain text in the logs/);
  assert.match(meeting.spoken[0]!.text, /should not log API tokens/);
});

test('proactive: without a native hand, the chat fallback is used only when configured', async () => {
  for (const fallback of ['none', 'chat'] as const) {
    const brain = new AssessingBrain();
    const meeting = new NoHandMeeting('m');
    const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain,
      policy: new AllowlistPolicy(new Set(['lead'])), agent: new ScriptedModel([]), people },
    { schedule: () => 0, cancel: () => undefined, assessmentIntervalMs: 0, handRaiseFallback: fallback });
    await engine.startSession('s', meeting);
    for (let i = 1; i <= 4; i++) await engine.onUtterance('s', { eventId: `u${i}`, actor: lead, text: `talk ${i}` });
    await settle();
    const chats = meeting.events.filter(e => e.type === 'chat');
    assert.equal(brain.calls, fallback === 'chat' ? 1 : 0);
    assert.equal(chats.length, fallback === 'chat' ? 1 : 0);
    if (fallback === 'chat') assert.match(chats[0]!.text!, /something to add about token storage/);
  }
});

test('when a participant interrupts, the rest of the streamed answer is not spoken (chat still has it)', async () => {
  class InterruptedMeeting extends RecordingMeeting {
    override async speak(message: string, options: { chatMirror?: boolean } = {}): Promise<void> {
      await super.speak(message, options);
      if (this.spoken.length === 1) throw new Error('speech interrupted by participant');
    }
  }
  const long = 'First point is the cache. ' + 'Then a much longer explanation follows with many words in it. '.repeat(6);
  const model = new ScriptedModel([{ text: long.trim() }]);
  const f = fixture(model, { meeting: new InterruptedMeeting('m') });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, explain the cache', '1');
  const meeting = f.meeting as InterruptedMeeting;
  assert.equal(meeting.spoken.length, 1);
  assert.equal(meeting.spoken[0]!.text, 'First point is the cache.');
  assert.equal(meeting.events.filter(e => e.type === 'chat').length, 1);
});

test('voice without queued playback: the lead-in and a short answer are each spoken once, whole', async () => {
  class NonStreamingMeeting extends RecordingMeeting {
    override readonly capabilities: ReadonlySet<Capability> = new Set(['listen', 'speak', 'chat_receipt']);
  }
  const answer = 'The cache keeps entries for five minutes. ' + 'It also has a much longer explanation that keeps going for a while. '.repeat(10);
  const model = new ScriptedModel([
    { text: 'Let me look at the cache.', tools: [{ name: 'search_code', input: { query: 'cache' } }] },
    { text: answer.trim() },
  ]);
  const f = fixture(model, { meeting: new NonStreamingMeeting('m') });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, how long does the cache keep things?', '1');
  const spoken = (f.meeting as NonStreamingMeeting).spoken.map(item => item.text);
  assert.equal(spoken[0], 'Let me look at the cache.');
  assert.ok(spoken[1]!.startsWith('The cache keeps entries for five minutes.'));
  assert.ok(spoken[1]!.split(/\s+/).length <= 90);
  assert.equal(spoken[2], 'I have put the rest in the chat.');
  assert.equal(spoken.length, 3);
});
