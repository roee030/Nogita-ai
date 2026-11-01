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

test('research trace records source coverage and omitted result items without answer text', () => {
  const trace = buildTurnTrace({
    model: 'claude-sonnet', ms: 200, toolUses: [], stepMs: [200],
    result: {
      answer: 'The retry fix landed [1]. The deployment status is unknown.', preface: '', lookups: [], toolCalls: ['repo_activity'],
      steps: 1, stoppedEarly: false, stops: [{ step: 0, stopReason: 'end_turn', maxTokens: 600 }],
      completion: { complete: true, createdTasks: 0, missing: [] },
      evidence: {
        sources: [{ id: 'S1', kind: 'commit', label: 'commit abc1234', tool: 'repo_activity', step: 0 }],
        cited: ['S1'],
      },
      resultTruncations: [{ tool: 'repo_activity', resultId: 'r1', omittedItems: 184, omittedLines: 0 }],
    },
  });

  assert.deepEqual(trace.research, {
    sources: [{ id: 'S1', kind: 'commit', tool: 'repo_activity', step: 0, cited: true }],
    claims: { total: 2, sourced: 1 },
    truncatedResults: [{ tool: 'repo_activity', resultId: 'r1', omittedItems: 184, omittedLines: 0 }],
  });
  assert.doesNotMatch(JSON.stringify(trace), /retry fix|deployment status|abc1234/);
});

test('research claim coverage validates citations and treats sentence citations and bullets as separate claims', () => {
  const trace = buildTurnTrace({ model: 'claude-sonnet', ms: 20, toolUses: [], stepMs: [20], result: {
    answer: 'The fix shipped. [1] The build passed. [1]\n- No citation claim\n- Another uncited claim [99]',
    preface: '', lookups: [], toolCalls: [], steps: 1, stoppedEarly: false,
    stops: [{ step: 0, stopReason: 'end_turn', maxTokens: 600 }], completion: { complete: true, createdTasks: 0, missing: [] },
    evidence: { sources: [{ id: 'S1', kind: 'commit', label: 'commit abc1234', tool: 'repo_activity', step: 0 }], cited: ['S1'] },
  } });

  assert.deepEqual(trace.research?.claims, { total: 4, sourced: 2 });
});

test('release report summarizes traced turns and truncations', () => {
  const report = analyse('meeting', [{
    at: 1, type: 'agent_trace', model: 'claude-sonnet', ms: 321, steps: 2, stoppedEarly: false,
    tools: [{ name: 'search_code', input: '{"query":"retry"}' }],
    stops: [{ step: 0, stopReason: 'max_tokens', maxTokens: 2_000, droppedToolCall: 'read_file', ms: 111 }],
  }]);

  assert.deepEqual(report.traces, { turns: 1, steps: 2, truncated: 1, turnMs: [321], stepMs: [111], models: { 'claude-sonnet': 1 },
    tools: { search_code: 1 }, stops: { max_tokens: 1 }, errors: {},
    research: { sources: 0, citedSources: 0, claims: 0, sourcedClaims: 0, truncatedResults: 0, omittedItems: 0, omittedLines: 0 } });
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

test('release report summarizes research sources, omitted items and sourced claims', () => {
  const report = analyse('meeting', [{
    at: 1, type: 'agent_trace', model: 'claude-sonnet', ms: 200, steps: 1, stoppedEarly: false, tools: [], stops: [],
    research: {
      sources: [{ id: 'S1', kind: 'commit', tool: 'repo_activity', step: 0, cited: true },
        { id: 'S2', kind: 'pull_request', tool: 'repo_activity', step: 0, cited: false }],
      claims: { total: 3, sourced: 2 },
      truncatedResults: [{ tool: 'repo_activity', resultId: 'r1', omittedItems: 184, omittedLines: 0 }],
    },
  }]);

  assert.deepEqual(report.traces.research, {
    sources: 2, citedSources: 1, claims: 3, sourcedClaims: 2, truncatedResults: 1, omittedItems: 184, omittedLines: 0,
  });
  const text = render([report]);
  assert.match(text, /Research sources cited \/ found \| 1 \/ 2/);
  assert.match(text, /Research claims backed by a source \| 2 \/ 3 \(67%\)/);
  assert.match(text, /Research results shortened \/ omitted items \| 1 \/ 184/);
});
