import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { MemoryMissionStore, MissionRunner, pendingApprovalsPrompt, type Mission } from '../src/core/missions.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const use = (name: string, input: Record<string, unknown>): AgentContent => ({ type: 'tool_use', id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, input });
const say = (text: string): AgentContent => ({ type: 'text', text });

/** The mission asks to open one task; a conversation turn approves only when its prompt names the waiting mission. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly turnSystems: string[] = [];
  private rounds: AgentContent[][] = [[use('create_task', { title: 'Document turn taking v2' })],
    [use('finish_mission', { summary: 'Opened KAN-50.', evidence: ['KAN-50'] })]];
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    if (request.usageContext?.startsWith('mission:')) {
      const round = this.rounds.shift() ?? [say('Done.')];
      return { content: round, stopReason: round.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    }
    this.turnSystems.push(request.turnSystem);
    if (request.messages.some(message => message.role === 'assistant')) return { content: [say('Approved.')], stopReason: 'end_turn' };
    const waiting = request.turnSystem.match(/^- (M-\w+):/m)?.[1];
    const content = waiting ? [use('decide_mission', { decision: 'approve', mission_id: waiting })] : [say('Nothing is waiting for your approval.')];
    return { content, stopReason: waiting ? 'tool_use' : 'end_turn' };
  }
}

function setup() {
  const store = new MemoryMissionStore();
  const created: string[] = [];
  const toolbox = (): AgentToolbox => ({
    specs: [{ name: 'create_task', description: 'create_task', input_schema: { type: 'object', properties: {} } }],
    isWrite: name => name === 'create_task',
    async run(_name, input) { created.push(String(input.title)); return { content: `Created KAN-50: ${String(input.title)}` }; },
  });
  const model = new ScriptedModel();
  let n = 0;
  const newRunner = () => new MissionRunner({ model, store, toolbox, newId: () => `M-A${++n}` });
  return { model, created, newRunner };
}

const roee = { id: 'roee', displayName: 'Roee', verified: true };

/** A mission waits for Roee's approval; then the process restarts and Roee goes on in a new chat thread. */
async function afterRestart(pendingApprovals: boolean, speaker = roee) {
  const { model, created, newRunner } = setup();
  const first = newRunner();
  const mission = await first.start({ goal: 'Open a task to document turn taking v2', owner: { id: 'roee', displayName: 'Roee' }, sessionId: 'meeting' });
  await first.idle();
  assert.equal(first.get(mission.id)!.status, 'awaiting_approval');

  const missions = newRunner();
  await missions.resumeAll();
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model },
  { missions, pendingApprovals, schedule: () => 0, cancel: () => undefined });
  await engine.startSession('thread', new DemoMeeting('thread'));
  await engine.onUtterance('thread', { eventId: 'e1', text: 'Nogita, approve it.', actor: speaker });
  await missions.idle();
  return { model, created, mission: missions.get(mission.id)! };
}

test('"approve it" after a restart, in a new thread, approves the waiting mission', async () => {
  const { model, created, mission } = await afterRestart(true);
  assert.match(model.turnSystems[0]!, /Waiting for Roee's approval/);
  assert.match(model.turnSystems[0]!, /create the task "Document turn taking v2"/);
  assert.deepEqual(created, ['Document turn taking v2']);
  assert.equal(mission.status, 'done');
});

test('with the flag off the turn is not told, as before', async () => {
  const { model, created, mission } = await afterRestart(false);
  assert.doesNotMatch(model.turnSystems[0]!, /approval/);
  assert.deepEqual(created, []);
  assert.equal(mission.status, 'awaiting_approval');
});

test('someone else is not shown another person\'s waiting approvals', async () => {
  const { model, created, mission } = await afterRestart(true, { id: 'dana', displayName: 'Dana', verified: true });
  assert.doesNotMatch(model.turnSystems[0]!, /approval/);
  assert.deepEqual(created, []);
  assert.equal(mission.status, 'awaiting_approval');
});

test('the prompt lists only missions waiting for approval, and asks which one when there are several', () => {
  const mission = (id: string, status: Mission['status'], summary?: string) => ({ id, goal: `goal of ${id}`, status,
    ...(summary ? { pending: { toolUseId: 't', tool: 'create_task', input: {}, summary, results: [], requestedAt: 0 } } : {}) }) as unknown as Mission;
  assert.equal(pendingApprovalsPrompt([mission('M-1', 'executing'), mission('M-2', 'done')], 'Roee'), '');
  const one = pendingApprovalsPrompt([mission('M-1', 'awaiting_approval', 'create the task "A"'), mission('M-2', 'executing')], 'Roee');
  assert.match(one, /^- M-1: create the task "A" \(mission: goal of M-1\)$/m);
  assert.doesNotMatch(one, /M-2|which one/);
  const two = pendingApprovalsPrompt([mission('M-1', 'awaiting_approval', 'a'), mission('M-3', 'awaiting_approval', 'b')], 'Roee');
  assert.match(two, /M-1[\s\S]*M-3[\s\S]*asking which one/);
});
