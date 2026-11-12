// P10-2: every write tool tells "the same action again" from "a new, different action" for the same event: on a retry,
// in a continued request (P9-26), and after a restart that reloads the receipts from disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileActionReceipts } from '../src/app/action-receipts.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import type { ActionReceipt, BoardPort, ChatPort, CreateTask, PullRequestPort, UpdateTask } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };

/** Every write that reached a provider, with nothing deduplicated on the provider side. */
class Recorder {
  readonly writes: string[] = [];
  readonly board: BoardPort = {
    name: 'rec-board',
    createTask: async (input: CreateTask) => this.receipt('task', `T-${this.count('task') + 1}`, `task:${input.title}`),
    updateTask: async (input: UpdateTask) => this.receipt('task', input.key, `update:${input.key}:${input.status ?? ''}:${input.comment ?? ''}`),
  };
  readonly chat: ChatPort = {
    name: 'rec-chat', listChannels: async () => [], readChannel: async () => [],
    postMessage: async (channel: string, text: string) => this.receipt('message', `#${channel}`, `post:${channel}:${text}`),
  };
  readonly drafts: PullRequestPort = {
    name: 'rec-git', openDraft: async input => this.receipt('draft_pr', `PR-${this.count('pr') + 1}`, `pr:${input.title}`),
  };
  private count(kind: string): number { return this.writes.filter(write => write.startsWith(`${kind}:`)).length; }
  private receipt(kind: ActionReceipt['kind'], label: string, write: string): ActionReceipt {
    this.writes.push(write.startsWith('task:') || write.startsWith('pr:') ? write.replace(/^(\w+):/, (_m, k) => `${k === 'task' ? 'task' : 'pr'}:`) : write);
    return { provider: 'rec', kind, label, url: `https://example.invalid/${label}` };
  }
}

type Completed = Map<string, ActionReceipt>;
/** The toolbox one agent run gets: the same event each time; `continuation` as the engine sets it for P9-26. */
function run(rec: Recorder, completed: Completed, continuation: boolean, options: { commentRetryGuard?: boolean } = {}) {
  return buildToolbox({ actor: lead, request: 'as asked', sessionId: 's', eventId: 'e1', writesApproved: true,
    policy: new AllowlistPolicy(new Set(['lead']), { draftPullRequests: true }), code: new DemoCode(),
    board: rec.board, chat: rec.chat, drafts: rec.drafts, completed, onReceipt: async () => {}, batchTasks: true,
    ...(continuation ? { continuation: true } : {}), ...(options.commentRetryGuard ? { commentRetryGuard: true } : {}) }).toolbox;
}

type Call = { tool: string; input: Record<string, unknown> };
interface Row {
  name: string;
  options?: { commentRetryGuard?: boolean };
  first: Call;
  /** The first action again, worded as a model repeats it: case and punctuation may differ. */
  same: Call;
  /** A different action of the same kind. */
  other: Call;
}
const ROWS: Row[] = [
  { name: 'create_task',
    first: { tool: 'create_task', input: { title: 'Release notes', description: 'Write them.' } },
    same: { tool: 'create_task', input: { title: 'release notes.', description: 'Write them.' } },
    other: { tool: 'create_task', input: { title: 'Changelog', description: 'Update it.' } } },
  { name: 'create_tasks (batch)',
    first: { tool: 'create_tasks', input: { tasks: [{ title: 'Release notes', description: 'Write them.' }] } },
    same: { tool: 'create_tasks', input: { tasks: [{ title: 'Release Notes', description: 'Write them.' }] } },
    other: { tool: 'create_tasks', input: { tasks: [{ title: 'Changelog', description: 'Update it.' }] } } },
  { name: 'update_task status',
    first: { tool: 'update_task', input: { key: 'KAN-1', status: 'Done' } },
    same: { tool: 'update_task', input: { key: 'KAN-1', status: 'Done' } },
    other: { tool: 'update_task', input: { key: 'KAN-2', status: 'Done' } } },
  { name: 'update_task comment',
    first: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Blocked on the API.' } },
    same: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Blocked on the API.' } },
    other: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Dana owns the fix.' } } },
  { name: 'update_task comment with NOGITA_COMMENT_RETRY_GUARD', options: { commentRetryGuard: true },
    first: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Blocked on the API.' } },
    same: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Blocked on the API.' } },
    other: { tool: 'update_task', input: { key: 'KAN-1', comment: 'Dana owns the fix.' } } },
  { name: 'update_tasks (batch)',
    first: { tool: 'update_tasks', input: { updates: [{ key: 'KAN-1', status: 'Done' }] } },
    same: { tool: 'update_tasks', input: { updates: [{ key: 'KAN-1', status: 'Done' }] } },
    other: { tool: 'update_tasks', input: { updates: [{ key: 'KAN-3', status: 'In Progress' }] } } },
  { name: 'post_message',
    first: { tool: 'post_message', input: { channel: 'eng', text: 'The release is out.' } },
    same: { tool: 'post_message', input: { channel: 'eng', text: 'The release is out.' } },
    other: { tool: 'post_message', input: { channel: 'eng', text: 'The changelog is updated.' } } },
  { name: 'open_draft_pr',
    first: { tool: 'open_draft_pr', input: { title: 'Fix the login redirect', description: 'Where and why.' } },
    same: { tool: 'open_draft_pr', input: { title: 'Fix the login redirect.', description: 'Where and why.' } },
    other: { tool: 'open_draft_pr', input: { title: 'Add a retry to the webhook', description: 'Where and why.' } } },
];

async function call(toolbox: ReturnType<typeof run>, { tool, input }: Call): Promise<void> {
  const outcome = await toolbox.run(tool, input);
  assert.ok(!outcome.isError, `${tool}: ${outcome.content}`);
}

function store(): { receipts: () => FileActionReceipts; files: () => string[]; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'nogita-p10-2-'));
  return { receipts: () => new FileActionReceipts(root),
    files: () => readdirSync(join(root, 'action-receipts')).map(file => readFileSync(join(root, 'action-receipts', file), 'utf8')),
    done: () => rmSync(root, { recursive: true, force: true }) };
}

for (const row of ROWS) {
  test(`${row.name}: a retry of the same event writes nothing again, in memory and after a restart`, async () => {
    const memory = new Recorder();
    const completed: Completed = new Map();
    await call(run(memory, completed, false, row.options), row.first);
    await call(run(memory, completed, false, row.options), row.first);
    assert.equal(memory.writes.length, 1, 'in memory');

    const disk = store();
    try {
      const rec = new Recorder();
      await call(run(rec, disk.receipts(), false, row.options), row.first);
      await call(run(rec, disk.receipts(), false, row.options), row.first);
      assert.equal(rec.writes.length, 1, 'after a restart');
    } finally { disk.done(); }
  });

  test(`${row.name}: a continued request finds the same action done and makes a new one exactly once`, async () => {
    for (const restart of [false, true]) {
      const disk = store();
      try {
        const rec = new Recorder();
        const memory: Completed = new Map();
        const receipts = () => restart ? disk.receipts() : memory;
        await call(run(rec, receipts(), false, row.options), row.first);
        // The speaker went on; the combined request runs under the first request's event.
        const continued = run(rec, receipts(), true, row.options);
        await call(continued, row.same);
        await call(continued, row.other);
        assert.equal(rec.writes.length, 2, `${restart ? 'after a restart' : 'in memory'}: ${rec.writes.join(' | ')}`);
        // Asked for the new one alone (the agent was told the first is done): still made, and only once.
        const rec2 = new Recorder();
        const memory2: Completed = new Map();
        const receipts2 = () => restart ? disk.receipts() : memory2;
        if (restart) for (const key of [...disk.receipts().keys()]) disk.receipts().delete(key);
        await call(run(rec2, receipts2(), false, row.options), row.first);
        await call(run(rec2, receipts2(), true, row.options), row.other);
        await call(run(rec2, receipts2(), true, row.options), row.other);
        assert.equal(rec2.writes.length, 2, `${restart ? 'after a restart' : 'in memory'}, new only: ${rec2.writes.join(' | ')}`);
      } finally { disk.done(); }
    }
  });
}

test('receipts on disk hold no title, comment or message text', async () => {
  const disk = store();
  try {
    const rec = new Recorder();
    const receipts = disk.receipts();
    for (const row of ROWS) await call(run(rec, receipts, false, row.options), row.first);
    await call(run(rec, receipts, true), ROWS[0]!.other);
    const saved = disk.files().join('\n');
    for (const words of ['Release notes', 'release notes', 'Changelog', 'Blocked on the API', 'The release is out', 'Fix the login redirect']) {
      assert.ok(!saved.includes(words), `"${words}" is on disk`);
    }
  } finally { disk.done(); }
});

test('a continued request does not skip approval: an unasked write is still refused', async () => {
  const rec = new Recorder();
  const toolbox = buildToolbox({ actor: lead, request: 'what is the status of the release?', sessionId: 's', eventId: 'e1',
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board: rec.board, completed: new Map(),
    onReceipt: async () => {}, continuation: true }).toolbox;
  const outcome = await toolbox.run('create_task', { title: 'Release notes', description: 'Write them.' });
  assert.equal(outcome.isError, true);
  assert.deepEqual(rec.writes, []);
});
