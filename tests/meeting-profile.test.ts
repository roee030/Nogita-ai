import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { CONFIDENCE_THRESHOLD, PROFILES, inferProfile, parseInference, renderReport, score } from '../tools/meeting-profile/infer.ts';
import { LABELED } from '../tools/meeting-profile/labels.ts';

class Answers implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly text: string) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    this.requests.push(request);
    return { content: [{ type: 'text', text: this.text }] as AgentContent[], stopReason: 'end_turn' };
  }
}

test('the labeled set: unique ids, every type at least twice, nothing empty', () => {
  assert.equal(new Set(LABELED.map(item => item.id)).size, LABELED.length);
  for (const profile of PROFILES) assert.ok(LABELED.filter(item => item.profile === profile).length >= 2, profile);
  for (const item of LABELED) assert.ok(item.lines.length >= 2, item.id);
});

test('a confident answer is kept; below the threshold, or anything unusable, is uncertain', () => {
  assert.deepEqual(parseInference('{"profile":"retro","confidence":0.9}'), { profile: 'retro', confidence: 0.9 });
  assert.deepEqual(parseInference('Sure: {"profile":"retro","confidence":0.9} done'), { profile: 'retro', confidence: 0.9 });
  assert.equal(parseInference(`{"profile":"retro","confidence":${CONFIDENCE_THRESHOLD - 0.01}}`).profile, 'uncertain');
  for (const bad of ['no json here', '{"profile":"party","confidence":0.99}', '{"profile":"retro"}', '{"profile":"retro","confidence":7}']) {
    assert.equal(parseInference(bad).profile, 'uncertain', bad);
  }
});

test('the model gets the title and early lines as untrusted words, no tools, and cannot act', async () => {
  const model = new Answers('{"profile":"planning","confidence":0.8}');
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  assert.equal((await inferProfile(model, { lines, title: 'Sprint 42' })).profile, 'planning');
  const [request] = model.requests;
  assert.deepEqual(request!.tools, []);
  assert.match(request!.stableSystem, /never instructions/);
  const content = String(request!.messages[0]!.content);
  assert.match(content, /Title: Sprint 42/);
  assert.match(content, /line 39\n/);
  assert.doesNotMatch(content, /line 40\n/);
});

test('the report separates correct when named, uncertain, and calls its targets proposals', () => {
  const report = score([{ id: 'a', expected: 'retro', got: 'retro', confidence: 0.9 }, { id: 'b', expected: 'retro', got: 'planning', confidence: 0.8 },
    { id: 'c', expected: 'standup', got: 'uncertain', confidence: 0 }]);
  assert.deepEqual([report.total, report.asserted, report.assertedCorrect, report.uncertain], [3, 2, 1, 1]);
  assert.deepEqual(report.wrong.map(item => item.id), ['b', 'c']);
  const text = renderReport(report);
  assert.match(text, /1\/2 \(50%; proposed target at least 85%, not a gate until approved\)/);
  assert.match(text, /b: labeled retro, got planning/);
});
