import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicBrain } from '../src/adapters/anthropic.ts';
import { probeConnections } from '../src/app/connection-probes.ts';
import type { ChatModelRequest } from '../src/core/agent.ts';

const FAST = 'claude-haiku-5-5';
const STRONG = 'claude-sonnet-5-5';

function streamResponse(text = 'Done.', inputTokens = 100, outputTokens = 10): Response {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function request(text: string, usageContext = 'meeting'): ChatModelRequest {
  return {
    stableSystem: 'stable', turnSystem: 'voice', usageContext, maxTokens: 200,
    messages: [{ role: 'user', content: text }],
    tools: [{ name: 'repo_activity', description: 'Recent repository changes', input_schema: { type: 'object' } },
      { name: 'create_tasks', description: 'Create tasks', input_schema: { type: 'object' } }],
  };
}

test('routing is off by default and quick voice answers stay on Haiku when enabled', async () => {
  const models: string[] = [];
  const http: typeof fetch = async (_url, init) => {
    models.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return streamResponse();
  };
  const off = new AnthropicBrain('key', FAST, http, {}, {}, { model: FAST, routingModel: STRONG });
  const on = new AnthropicBrain('key', FAST, http, {}, {}, { model: FAST, routingModel: STRONG, routing: true });

  await off.streamChat(request('What changed in the repository this week?', 'off'), () => {});
  await on.streamChat(request('What is the capital of France?', 'quick'), () => {});

  assert.deepEqual(models, [FAST, FAST]);
  assert.deepEqual(off.routingTraceFor('off'), [{ step: 0, model: FAST, reason: 'flag_off' }]);
  assert.deepEqual(on.routingTraceFor('quick'), [{ step: 0, model: FAST, reason: 'fast_voice' }]);
});

test('research and multi-action steps use Sonnet and record the model and reason for every step', async () => {
  const models: string[] = [];
  const brain = new AnthropicBrain('key', FAST, async (_url, init) => {
    models.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return streamResponse();
  }, {}, {}, { model: FAST, routingModel: STRONG, routing: true, maxRoutedCallsPerSession: 4 });
  brain.beginUsageSession('meeting');

  const research = request('What changed in the repository this week?');
  research.messages.unshift({ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi.' });
  await brain.streamChat(research, () => {});
  await brain.streamChat(request('Create three tasks for the API, UI, and documentation.'), () => {});

  assert.deepEqual(models, [STRONG, STRONG]);
  assert.deepEqual(brain.routingTraceFor('meeting'), [
    { step: 0, model: STRONG, reason: 'research' },
    { step: 1, model: STRONG, reason: 'multiple_actions' },
  ]);
});

test('the per-meeting routed-call cap falls back to Haiku and mixed usage uses each model price', async () => {
  const models: string[] = [];
  const brain = new AnthropicBrain('key', FAST, async (_url, init) => {
    models.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return streamResponse('Done.', 1_000, 100);
  }, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, {}, {
    model: FAST, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    routing: true, routingModel: STRONG, routingInputUsdPerMillion: 3, routingOutputUsdPerMillion: 6,
    maxRoutedCallsPerSession: 1,
  });
  brain.beginUsageSession('meeting');

  await brain.streamChat(request('What changed today?'), () => {});
  await brain.streamChat(request('Why did the CI fail?'), () => {});

  assert.deepEqual(models, [STRONG, FAST]);
  assert.deepEqual(brain.routingTraceFor('meeting'), [
    { step: 0, model: STRONG, reason: 'research' },
    { step: 1, model: FAST, reason: 'meeting_budget' },
  ]);
  assert.equal(brain.usageFor('meeting').estimatedUsd, 0.0048);
});

test('Anthropic readiness requires the routed model only while model routing is enabled', async () => {
  const seenBodies: string[] = [];
  const http: typeof fetch = async (url) => {
    if (!String(url).includes('anthropic.com')) return new Response('{}', { status: 500 });
    seenBodies.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: FAST }] }), { status: 200 });
  };
  const base = { ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: FAST, NOGITA_MODE: 'live', NOGITA_AGENT: 'on' };

  const off = await probeConnections(base, http);
  const on = await probeConnections({ ...base, NOGITA_MODEL_ROUTING: 'true', ANTHROPIC_ROUTING_MODEL: STRONG }, http);

  assert.equal(off.checks.find(check => check.provider === 'anthropic')?.status, 'connected');
  assert.equal(on.checks.find(check => check.provider === 'anthropic')?.status, 'failed');
  assert.equal(seenBodies.length, 2);
});
