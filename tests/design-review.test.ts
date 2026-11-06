import test from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_REVIEW_PROMPT, isDesignQuestion } from '../src/core/agent-prompt.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

test('design questions, and the factual ones that are not', () => {
  for (const ask of ['what do you think about this record structure?', 'how should we model the participant record?',
    'should we store the status on the task or in a separate table?', 'what is the better way to split this service?',
    'what are the trade-offs here?', 'מה דעתך על המבנה הזה?', 'איך כדאי לשמור את הרשומה?'])
    assert.equal(isDesignQuestion(ask), true, ask);
  for (const ask of ['what landed today?', 'which file starts the server?', 'how many open tasks are there?',
    'how does the router work?', 'should I go to lunch?', 'open a task for the cache'])
    assert.equal(isDesignQuestion(ask), false, ask);
});

class Model implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly reply: string) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    onText(this.reply);
    return { content: [{ type: 'text', text: this.reply }] as AgentContent[], stopReason: 'end_turn' };
  }
}
class Meeting extends DemoMeeting {
  readonly spoken: string[] = [];
  readonly chat: string[] = [];
  override async speak(message: string): Promise<void> { this.spoken.push(message); await super.speak(message); }
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
}
const roee = { id: 'roee', displayName: 'Roee', verified: true };
const guest = { id: 'guest', displayName: 'Guest', verified: false };
const ANSWER = `Keep the status on the task row, because every query already reads it there. Options: 1. A column on tasks: simple and fast to read, but history is lost; see src/core/contracts.ts. 2. A separate status_events table: full history, but every read needs a join and more code changes; see src/adapters/jira.ts. Would change my mind: if reports need the history of each status change.`;

async function ask(designReview: boolean, request: string, actor = roee) {
  const model = new Model(ANSWER);
  const m = new Meeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
    { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, designReview });
  await engine.startSession('s', m);
  await engine.onUtterance('s', { text: request, eventId: '1', actor });
  return { model, m };
}

test('NOGITA_DESIGN_REVIEW: the design instructions and room to read; one sentence aloud, the options in the chat', async () => {
  const on = await ask(true, 'Nogita, should we store the status on the task or in a separate table?');
  const request = on.model.requests[0]!;
  assert.ok(request.turnSystem.includes(DESIGN_REVIEW_PROMPT));
  assert.equal(request.maxTokens, 2_000);
  const spoken = on.m.spoken.join(' ');
  assert.match(spoken, /^Let me look at the code\./);
  assert.match(spoken, /Keep the status on the task row, because every query already reads it there\./);
  assert.doesNotMatch(spoken, /status_events/);
  assert.ok(on.m.chat.some(text => text.includes('status_events') && text.includes('Would change my mind')));
});

test('off, a factual question, or a guest: no design prompt', async () => {
  for (const { flag, request, actor } of [
    { flag: false, request: 'Nogita, should we store the status on the task or in a separate table?', actor: roee },
    { flag: true, request: 'Nogita, which file starts the server?', actor: roee },
    { flag: true, request: 'Nogita, what do you think about this record?', actor: guest },
  ]) {
    const { model } = await ask(flag, request, actor);
    assert.equal(model.requests[0]?.turnSystem.includes(DESIGN_REVIEW_PROMPT) ?? false, false, request);
  }
});

test('her steps between tool calls are not spoken: one acknowledgement, then the recommendation', async () => {
  let call = 0;
  const model: ChatModel = { agentModel: 'scripted', async streamChat(_request, onText) {
    if (call++ === 0) {
      onText('I should check how the engine holds session state.');
      return { content: [{ type: 'text', text: 'I should check how the engine holds session state.' },
        { type: 'tool_use', id: 't1', name: 'search_code', input: { query: 'session state' } }] as AgentContent[], stopReason: 'tool_use' };
    }
    onText(ANSWER);
    return { content: [{ type: 'text', text: ANSWER }] as AgentContent[], stopReason: 'end_turn' };
  } };
  const m = new Meeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
    { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, designReview: true });
  await engine.startSession('s', m);
  await engine.onUtterance('s', { text: 'Nogita, how should we model the status record?', eventId: '1', actor: roee });
  assert.doesNotMatch(m.spoken.join(' '), /I should check/);
  assert.match(m.spoken.join(' '), /Keep the status on the task row/);
});
