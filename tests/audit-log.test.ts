import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAuditLog, originOf } from '../src/app/audit-log.ts';
import { auditedPorts, buildToolbox, type WriteAudit } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import type { ActionReceipt, ChatPort } from '../src/core/contracts.ts';

const roee = { id: 'roee', displayName: 'Roee', verified: true };

function chatPort(fail = false): ChatPort & { posted: string[] } {
  const posted: string[] = [];
  return { name: 'Slack', posted, listChannels: async () => [], readChannel: async () => [],
    async postMessage(channel, text): Promise<ActionReceipt> {
      if (fail) throw new Error('Slack said channel_not_found');
      posted.push(`${channel}: ${text}`);
      return { provider: 'slack', kind: 'message', label: `#${channel}`, url: `https://slack.example/${channel}/1` };
    } };
}

function toolbox(audit: (write: WriteAudit) => void, options: { sessionId?: string; chat?: ChatPort; request?: string } = {}) {
  const board = new MemoryBoard('Jira', 'KAN');
  const { toolbox } = buildToolbox({ actor: roee, request: options.request ?? 'Nogita, create a task to add retries and post in #dev that it is open',
    sessionId: options.sessionId ?? 'meeting-1', eventId: 'e1', policy: new AllowlistPolicy(new Set(['roee'])), code: new DemoCode(),
    board, chat: options.chat ?? chatPort(), completed: new Map(), onReceipt: async () => undefined, audit });
  return { toolbox, board };
}

test('every write the toolbox makes is reported with who asked, where, what was sent and the receipt', async () => {
  const writes: WriteAudit[] = [];
  const { toolbox: tools, board } = toolbox(write => writes.push(write));
  await tools.run('create_task', { title: 'Add retries to the Jira client', description: 'Bounded retries.' });
  await tools.run('post_message', { channel: 'dev', text: 'The retries task is open.' });
  // Reads go through untouched and are not writes.
  await tools.run('search_tasks', { query: 'retries' });
  assert.equal(board.tasks.length, 1);
  assert.deepEqual(writes.map(write => [write.action, write.ok, write.actor.id, write.sessionId]),
    [['create_task', true, 'roee', 'meeting-1'], ['post_message', true, 'roee', 'meeting-1']]);
  assert.equal(writes[0]!.sent.title, 'Add retries to the Jira client');
  assert.equal(writes[0]!.receipt?.label, 'KAN-1');
  assert.deepEqual(writes[1]!.sent, { channel: 'dev', text: 'The retries task is open.' });
});

test('a write that fails is logged with its error, and still fails', async () => {
  const writes: WriteAudit[] = [];
  const { toolbox: tools } = toolbox(write => writes.push(write), { chat: chatPort(true) });
  const result = await tools.run('post_message', { channel: 'dev', text: 'Hello.' }).catch(error => ({ content: String(error), isError: true }));
  assert.equal(result.isError, true);
  assert.deepEqual(writes.map(write => [write.action, write.ok, write.error]), [['post_message', false, 'Slack said channel_not_found']]);
});

test('a broken audit hook never fails the write it reports', async () => {
  const chat = chatPort();
  const ports = auditedPorts({ actor: roee, sessionId: 's', eventId: 'e', board: new MemoryBoard(), chat }, () => { throw new Error('disk full'); });
  const receipt = await ports.chat!.postMessage('dev', 'Still sent.');
  assert.equal(receipt.label, '#dev');
  assert.deepEqual(chat.posted, ['dev: Still sent.']);
});

test('the log file is append-only JSON lines, read back newest first with filters; a torn last line is skipped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-audit-'));
  try {
    let clock = Date.parse('2026-11-01T10:00:00Z');
    const log = new FileAuditLog(directory, () => (clock += 60_000));
    const { toolbox: meeting } = toolbox(write => log.record(write));
    await meeting.run('create_task', { title: 'First', description: 'x'.repeat(3_000) });
    const { toolbox: mission } = toolbox(write => log.record(write), { sessionId: 'mission-M-AB12' });
    await mission.run('post_message', { channel: 'dev', text: 'From the mission.' });
    const { toolbox: thread } = toolbox(write => log.record({ ...write, actor: { id: 'dana', displayName: 'Dana' } }), { sessionId: 'slack:C1:1730.1' });
    await thread.run('post_message', { channel: 'dev', text: 'From Slack.' });
    await appendFile(log.file, '{"at":"2026-11-01T11:00:00.000Z","acti');

    const lines = (await readFile(log.file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4);
    const all = log.read();
    assert.deepEqual(all.map(entry => entry.origin), [{ kind: 'slack', id: 'C1:1730.1' }, { kind: 'mission', id: 'M-AB12' }, { kind: 'meeting', id: 'meeting-1' }]);
    assert.equal((all[2]!.sent.description as string).length, 2_001, 'long text is shortened');
    assert.deepEqual(log.read({ actorId: 'dana' }).map(entry => entry.sent.text), ['From Slack.']);
    assert.deepEqual(log.read({ origin: 'mission:M-AB12' }).map(entry => entry.action), ['post_message']);
    assert.deepEqual(log.read({ since: all[1]!.at }).length, 2);
    assert.deepEqual(log.read({ limit: 1 }).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('origins: meetings, Slack threads, missions', () => {
  assert.deepEqual(originOf('bot_abc'), { kind: 'meeting', id: 'bot_abc' });
  assert.deepEqual(originOf('slack:C1:1.2'), { kind: 'slack', id: 'C1:1.2' });
  assert.deepEqual(originOf('mission-M-X1'), { kind: 'mission', id: 'M-X1' });
});
