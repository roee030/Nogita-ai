import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileActionReceipts } from '../src/app/action-receipts.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import type { ActionReceipt } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const receipt = (label: string): ActionReceipt => ({ provider: 'demo-jira', kind: 'task', label, url: `https://example.invalid/${label}` });

function directory(): { root: string; files: () => string[]; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'nogita-receipts-'));
  return { root, files: () => readdirSync(join(root, 'action-receipts')), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a receipt written by one process is there for the next one', () => {
  const dir = directory();
  try {
    const first = new FileActionReceipts(dir.root);
    first.set('s:e1:task:1', receipt('DEMO-1'));
    const restarted = new FileActionReceipts(dir.root);
    assert.deepEqual(restarted.get('s:e1:task:1'), receipt('DEMO-1'));
    assert.equal(restarted.size, 1);
    // Named by a hash; the file holds the key and the receipt, no request text.
    assert.match(dir.files()[0]!, /^[0-9a-f]{64}\.json$/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir.root, 'action-receipts', dir.files()[0]!), 'utf8'))), ['key', 'receipt', 'at']);
  } finally { dir.done(); }
});

test('deleting a receipt removes it from disk; clear removes all', () => {
  const dir = directory();
  try {
    const receipts = new FileActionReceipts(dir.root);
    receipts.set('s:e1:task:1', receipt('DEMO-1'));
    receipts.set('s:e1:task:2', receipt('DEMO-2'));
    receipts.set('t:e1:task:1', receipt('DEMO-3'));
    // The engine's own clean-up when a meeting ends: delete while walking the keys.
    for (const key of receipts.keys()) if (key.startsWith('s:')) receipts.delete(key);
    assert.deepEqual([...new FileActionReceipts(dir.root).keys()], ['t:e1:task:1']);
    receipts.clear();
    assert.equal(new FileActionReceipts(dir.root).size, 0);
    assert.deepEqual(dir.files(), []);
  } finally { dir.done(); }
});

test('old receipts, the oldest past the cap, and broken files are dropped on load', () => {
  const dir = directory();
  try {
    let now = 1_000_000_000;
    const receipts = new FileActionReceipts(dir.root, { now: () => now, maxEntries: 2, retentionMs: 60 * 60_000 });
    receipts.set('a', receipt('A'));
    now += 1000;
    receipts.set('b', receipt('B'));
    now += 1000;
    receipts.set('c', receipt('C'));
    assert.deepEqual([...receipts.keys()], ['b', 'c']);
    writeFileSync(join(dir.root, 'action-receipts', `${'0'.repeat(64)}.json`), '{"key":');
    writeFileSync(join(dir.root, 'action-receipts', `${'1'.repeat(64)}.json.123.tmp`), 'half');
    assert.deepEqual([...new FileActionReceipts(dir.root, { now: () => now }).keys()], ['b', 'c']);
    assert.equal(dir.files().length, 2);
    now += 2 * 60 * 60_000;
    assert.equal(new FileActionReceipts(dir.root, { now: () => now, retentionMs: 60 * 60_000 }).size, 0);
    assert.deepEqual(dir.files(), []);
  } finally { dir.done(); }
});

test('the same event after a restart does not create the task again, and still posts its link', async () => {
  const dir = directory();
  try {
    const board = new DemoBoard();
    const run = async () => {
      const meeting = new DemoMeeting('m');
      const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['lead'])) },
        { receipts: new FileActionReceipts(dir.root) });
      await engine.startSession('s', meeting);
      const result = await engine.onUtterance('s', { text: 'Nogita, create a task to check authentication refresh tokens', eventId: 'e1', actor: lead });
      return { result, meeting };
    };
    const first = await run();
    const retried = await run();
    assert.equal(first.result, 'completed');
    assert.equal(retried.result, 'completed');
    assert.equal(board.tasks.length, 1);
    const links = (meeting: DemoMeeting) => meeting.events.filter(event => event.type === 'chat' && event.text?.includes('DEMO-1: https://')).length;
    assert.equal(links(first.meeting), 1);
    assert.equal(links(retried.meeting), 1);
  } finally { dir.done(); }
});

test('without a store the engine keeps receipts in memory only, as before', async () => {
  const board = new DemoBoard();
  for (let restart = 0; restart < 2; restart++) {
    const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['lead'])) });
    await engine.startSession('s', new DemoMeeting('m'));
    await engine.onUtterance('s', { text: 'Nogita, create a task to check authentication refresh tokens', eventId: 'e1', actor: lead });
  }
  assert.equal(board.tasks.length, 2);
});

test('a retried batch after a restart writes only the items that did not finish', async () => {
  const dir = directory();
  try {
    const board = new MemoryBoard('memory', 'MEM', new Map([['dana', 'Dana Katz']]));
    const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'dana', displayName: 'Dana Katz' }]);
    const toolbox = () => buildToolbox({ actor: lead, request: 'open three tasks', sessionId: 's', eventId: 'e1', people,
      policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new FileActionReceipts(dir.root),
      batchTasks: true, onReceipt: async () => {} }).toolbox;
    const tasks = [1, 2, 3].map(n => ({ title: `Task ${n}`, description: `Item ${n}.`, assignee: 'Dana' }));
    await toolbox().run('create_tasks', { tasks: tasks.slice(0, 2) });
    // The process died before the third item; the retried event sends all three.
    const result = await toolbox().run('create_tasks', { tasks });
    assert.deepEqual(board.tasks.map(task => task.title), ['Task 1', 'Task 2', 'Task 3']);
    assert.match(result.content, /3 of 3/);
  } finally { dir.done(); }
});
