import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTurnTrace, TurnLog } from '../src/app/turn-log.ts';
import { analyse, render } from '../tools/turn-report.ts';

test('turn trace keeps operational metadata but no transcript text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-trace-'));
  const trace = buildTurnTrace({
    id: 7,
    model: 'claude-sonnet',
    ms: 321,
    result: {
      answer: 'secret final answer', preface: 'secret lead-in', lookups: ['secret tool output'],
      toolCalls: ['search_code'], steps: 2, stoppedEarly: true, completion: { complete: true, createdTasks: 0, missing: [] },
      stops: [
        { step: 0, stopReason: 'max_tokens', maxTokens: 2_000, droppedToolCall: 'read_file' },
        { step: 1, stopReason: 'end_turn', maxTokens: 600 },
      ],
    },
    toolUses: [{ name: 'search_code', input: { query: 'x'.repeat(300), path: 'src/core' } }],
    stepMs: [111, 210],
  });

  const log = new TurnLog(directory, 'redacted', 'secret', () => 123);
  log.record('meeting', trace);
  await log.flush();
  const [file] = await readdir(join(directory, 'turns'));
  const line = await readFile(join(directory, 'turns', file!), 'utf8');
  const event = JSON.parse(line);

  assert.equal(event.type, 'agent_trace');
  assert.deepEqual(event, {
    at: 123, type: 'agent_trace', id: 7, model: 'claude-sonnet', ms: 321, steps: 2, stoppedEarly: true,
    tools: [{ name: 'search_code', input: '{"query":"[string:300]","path":"[string:8]"}' }],
    stops: [
      { step: 0, stopReason: 'max_tokens', maxTokens: 2_000, droppedToolCall: 'read_file', ms: 111 },
      { step: 1, stopReason: 'end_turn', maxTokens: 600, ms: 210 },
    ],
  });
  assert.doesNotMatch(line, /secret final answer|secret lead-in|secret tool output/);
  assert.doesNotMatch(line, /xxxxxxxx|src\/core/);
});

test('failed agent turn still produces an operational trace', () => {
  assert.deepEqual(buildTurnTrace({ model: 'claude-sonnet', ms: 900, toolUses: [], stepMs: [400], error: 'aborted' }), {
    type: 'agent_trace', model: 'claude-sonnet', ms: 900, steps: 1, stoppedEarly: true,
    tools: [], stops: [], error: 'aborted', stepMs: [400],
  });
});

test('release report summarizes traced turns and truncations', () => {
  const report = analyse('meeting', [{
    at: 1, type: 'agent_trace', model: 'claude-sonnet', ms: 321, steps: 2, stoppedEarly: false,
    tools: [{ name: 'search_code', input: '{"query":"retry"}' }],
    stops: [{ step: 0, stopReason: 'max_tokens', maxTokens: 2_000, droppedToolCall: 'read_file', ms: 111 }],
  }]);

  assert.deepEqual(report.traces, { turns: 1, steps: 2, truncated: 1, turnMs: [321], stepMs: [111], models: { 'claude-sonnet': 1 },
    tools: { search_code: 1 }, stops: { max_tokens: 1 }, errors: {} });
  assert.match(render([report]), /Agent turns \/ steps \| 1 \/ 2/);
  assert.match(render([report]), /Truncated agent turns \| 1/);
  assert.match(render([report]), /Agent models \| claude-sonnet 1/);
  assert.match(render([report]), /Agent tools \| search_code 1/);
  assert.match(render([report]), /Agent stop reasons \| max_tokens 1/);
});

test('release report keeps failed-step timing separate from truncations', () => {
  const report = analyse('meeting', [{
    at: 1, type: 'agent_trace', model: 'claude-sonnet', ms: 900, steps: 1, stoppedEarly: true,
    tools: [], stops: [], error: 'aborted', stepMs: [400],
  }]);

  assert.equal(report.traces.truncated, 0);
  assert.deepEqual(report.traces.stepMs, [400]);
  assert.deepEqual(report.traces.errors, { aborted: 1 });
  assert.match(render([report]), /Agent errors \| aborted 1/);
});
