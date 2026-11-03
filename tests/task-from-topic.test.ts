import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { stableAgentPrompt, TASK_FROM_TOPIC_RULE } from '../src/core/agent-prompt.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

test('with the flag, both prompts say a named topic is enough, and the voice prompt shows the "for me" example', () => {
  for (const voice of [true, false]) {
    const on = stableAgentPrompt({ voice, taskFromTopic: true });
    assert.ok(on.includes(TASK_FROM_TOPIC_RULE), `voice=${voice}`);
    assert.ok(!stableAgentPrompt({ voice }).includes(TASK_FROM_TOPIC_RULE), `voice=${voice}`);
  }
  assert.match(stableAgentPrompt({ voice: true, taskFromTopic: true }), /open a task for me to update the onboarding docs\.\" Good: \(create it now/);
  assert.match(TASK_FROM_TOPIC_RULE, /Never ask what the task should say/);
  assert.match(TASK_FROM_TOPIC_RULE, /only when no topic was said at all/);
  // Without this, asking for tasks made the asker their owner (the eval's two-, four- and five-task cases).
  assert.match(TASK_FROM_TOPIC_RULE, /Leave assignee empty unless they named an owner/);
});

/** Opens the task on the first step when its prompt says a topic is enough, else asks what it should say (the eval's failure). */
class TopicModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    if (request.messages.some(message => message.role === 'assistant')) { onText('Done, it\'s yours.'); return { content: [{ type: 'text', text: 'Done, it\'s yours.' }], stopReason: 'end_turn' }; }
    const createTask = request.tools.find(tool => tool.name === 'create_task');
    if (request.stableSystem.includes(TASK_FROM_TOPIC_RULE) && /create it now from their words/.test(createTask?.description ?? '')) {
      return { content: [{ type: 'tool_use', id: 't1', name: 'create_task',
        input: { title: 'Update the onboarding docs', description: 'Dana asked in the meeting.', assignee: 'me' } }], stopReason: 'tool_use' };
    }
    const ask = 'Sure, what exactly needs updating in the onboarding docs?';
    onText(ask);
    return { content: [{ type: 'text', text: ask }], stopReason: 'end_turn' };
  }
}

async function ask(taskFromTopic: boolean) {
  const model = new TopicModel();
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['dana'])), agent: model },
    { taskFromTopic, agentCacheWarmup: false, schedule: () => 0, cancel: () => undefined });
  await engine.startSession('s', new DemoMeeting('m'));
  await engine.onUtterance('s', { eventId: 'e1', text: 'Nogita, open a task for me to update the onboarding docs.', actor: { id: 'dana', displayName: 'Dana Katz', verified: true } });
  return { model, board };
}

test('"open a task for me to update the onboarding docs" is created at once with the flag, and asked about without it', async () => {
  const on = await ask(true);
  assert.deepEqual(on.board.tasks.map(task => task.title), ['Update the onboarding docs']);

  const off = await ask(false);
  assert.deepEqual(off.board.tasks, []);
  assert.ok(!off.model.requests[0]!.stableSystem.includes(TASK_FROM_TOPIC_RULE));
  assert.doesNotMatch(off.model.requests[0]!.tools.find(tool => tool.name === 'create_task')!.description, /create it now/);
});
