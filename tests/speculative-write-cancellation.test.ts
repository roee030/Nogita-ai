import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentTurn, type ChatModel } from '../src/core/agent.ts';

const model: ChatModel = { agentModel: 'fake', streamChat: async () => ({
  content: [
    { type: 'tool_use', id: 'one', name: 'write_one', input: {} },
    { type: 'tool_use', id: 'two', name: 'write_two', input: {} },
  ], stopReason: 'tool_use',
}) };

function turn(signal: AbortSignal, run: (name: string) => Promise<{ content: string }>): AgentTurn {
  return { stableSystem: '', turnSystem: '', messages: [], stream: true, signal,
    toolbox: { specs: [], isWrite: () => true, run } };
}

test('rollback releases an agent waiting behind a never-confirmed write gate without executing a write', async () => {
  const abort = new AbortController();
  const writes: string[] = [];
  let waiting!: () => void;
  const atGate = new Promise<void>(resolve => { waiting = resolve; });
  const running = runAgent(model, { ...turn(abort.signal, async name => { writes.push(name); return { content: 'ok' }; }),
    beforeWrite: () => { waiting(); return new Promise<void>(() => {}); } });
  const rejected = assert.rejects(running, /rolled back/);
  await atGate;
  abort.abort(new Error('rolled back'));
  await rejected;
  assert.deepEqual(writes, []);
});

test('cancellation during the first write prevents the second write in the same model response', async () => {
  const abort = new AbortController();
  const writes: string[] = [];
  await assert.rejects(runAgent(model, turn(abort.signal, async name => {
    writes.push(name);
    abort.abort(new Error('cancelled during write'));
    return { content: 'first already committed' };
  })), /cancelled during write/);
  assert.deepEqual(writes, ['write_one']);
});
