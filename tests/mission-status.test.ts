import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse, ToolOutcome } from '../src/core/agent.ts';
import { MemoryMissionStore, MissionRunner, missionReport } from '../src/core/missions.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const use = (name: string, input: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 7)}`): AgentContent =>
  ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentContent => ({ type: 'text', text });

/** Plays the mission's rounds in order; conversation turns get `conversation`. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly conversationRequests: ChatModelRequest[] = [];
  constructor(private readonly rounds: AgentContent[][], private readonly conversation: (request: ChatModelRequest) => AgentContent[] = () => []) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (!request.usageContext?.startsWith('mission:')) {
      this.conversationRequests.push(structuredClone(request));
      const content = this.conversation(request);
      for (const block of content) if (block.type === 'text') onText(block.text);
      return { content, stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    }
    const round = this.rounds.shift() ?? [say('Nothing more.')];
    return { content: round, stopReason: round.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}

/** Three tasks to open; the one titled "Broken" fails, KAN-99 does not exist. */
function tools(): AgentToolbox {
  let next = 40;
  const handlers: Record<string, (input: Record<string, unknown>) => ToolOutcome> = {
    get_task: input => input.key === 'KAN-20'
      ? { content: 'KAN-20: Checkout page shows stale prices https://jira.example/browse/KAN-20' }
      : { content: 'not found', isError: true },
    recent_commits: () => ({ content: 'a1b2c3d fix: price cache https://github.com/acme/shop/commit/a1b2c3d' }),
    create_task: input => input.title === 'Broken' ? { content: 'Jira said 500', isError: true }
      : { content: `Created KAN-${next}: ${String(input.title)} https://jira.example/browse/KAN-${next++}` },
  };
  return {
    specs: Object.keys(handlers).map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } })),
    isWrite: name => name === 'create_task',
    async run(name, input) { return handlers[name]?.(input) ?? { content: 'unknown tool', isError: true }; },
  };
}

function runner(model: ChatModel) {
  let n = 0;
  return new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: () => tools(), newId: () => `M-S${++n}` });
}
const owner = { id: 'roee', displayName: 'Roee' };

test('the report says what was done, what failed and what is still open, with what it changed as the first source', async () => {
  const model = new ScriptedModel([
    [use('get_task', { key: 'KAN-20' }), use('get_task', { key: 'KAN-99' })],
    [use('create_task', { title: 'Cache headers' })],
    [use('create_task', { title: 'Broken' })],
    [use('create_task', { title: 'Price tests' })],
  ]);
  const missions = runner(model);
  const mission = await missions.start({ goal: 'Open three tasks for KAN-20', owner });
  await missions.idle();
  await missions.approve(mission.id, 'roee');
  await missions.idle();
  await missions.approve(mission.id, 'roee');
  await missions.idle();

  const report = missionReport(missions.get(mission.id)!);
  assert.equal(report.status, 'awaiting_approval');
  assert.deepEqual(report.done, ['create the task "Cache headers"']);
  assert.equal(report.failed.length, 2, report.failed.join(' | '));
  assert.match(report.failed[0]!, /Checking the board \(failed\)/);
  assert.equal(report.failed[1], 'create the task "Broken": Jira said 500');
  assert.deepEqual(report.open, ['Waiting for Roee to approve: create the task "Price tests"']);
  assert.equal(report.sources[0]!.label, 'KAN-40');
  assert.equal(report.sources[0]!.url, 'https://jira.example/browse/KAN-40');
  assert.ok(report.sources.some(source => source.label === 'KAN-20'));
});

test('a finished mission has nothing open; the sources its result cites come before the rest', async () => {
  const model = new ScriptedModel([
    [use('get_task', { key: 'KAN-20' }), use('recent_commits', {})],
    [use('record_finding', { finding: 'The cache fix landed in a1b2c3d.' })],
    [use('finish_mission', { summary: 'KAN-20 is fixed by a1b2c3d.', evidence: ['commit a1b2c3d'] })],
  ]);
  const missions = runner(model);
  const mission = await missions.start({ goal: 'Is KAN-20 fixed?', owner });
  await missions.idle();
  const report = missionReport(missions.get(mission.id)!);
  assert.equal(report.status, 'done');
  assert.deepEqual(report.open, []);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.done, ['Finished: KAN-20 is fixed by a1b2c3d.']);
  assert.deepEqual(report.findings, ['The cache fix landed in a1b2c3d.']);
  assert.deepEqual(report.sources.map(source => source.label), ['commit a1b2c3d', 'KAN-20']);
});

async function meetingWith(missionStatus: boolean) {
  const model = new ScriptedModel([
    [use('create_task', { title: 'Cache headers' })],
    [use('create_task', { title: 'Broken' })],
  ], request => {
    const said = String(request.messages[0]?.content ?? '').split('says to you now:').at(-1) ?? '';
    const answered = request.messages.some(message => message.role === 'assistant');
    if (/what's left/i.test(said) && request.tools?.some(tool => tool.name === 'mission_status')) {
      return answered ? [say('One task is open, one failed.')] : [use('mission_status', {})];
    }
    return answered || !/what's left/i.test(said) ? [say('Okay.')] : [use('missions_status', {})];
  });
  const missions = runner(model);
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model },
  { missions, missionStatus, schedule: () => 0, cancel: () => undefined, floor: { talkingMs: 20, resumeAfterMs: 20 } });
  await engine.startSession('s', meeting);
  const first = await missions.start({ goal: 'Open two tasks', owner, sessionId: 's' });
  await missions.idle();
  await missions.approve(first.id, 'roee');
  await missions.idle();
  return { model, engine, missions };
}

test('mission_status answers "what\'s left?" from the store, for the person who asked', async () => {
  const { model, engine } = await meetingWith(true);
  await engine.onUtterance('s', { text: "Nogita, what's left from what I asked?", eventId: '1', actor: { id: 'roee', displayName: 'Roee', verified: true } });
  const result = JSON.stringify(model.conversationRequests.at(-1)!.messages.at(-1)!.content);
  assert.match(result, /M-S1 \[awaiting_approval\] Open two tasks/);
  assert.match(result, /Done:\\n- create the task \\"Cache headers\\"/);
  assert.match(result, /Still open:\\n- Waiting for Roee to approve: create the task \\"Broken\\"/);
  assert.match(result, /Sources:\\n- KAN-40 .*https:\/\/jira.example\/browse\/KAN-40/);
});

test('mission_status is off unless the flag is set', async () => {
  const { model, engine } = await meetingWith(false);
  await engine.onUtterance('s', { text: "Nogita, what's left from what I asked?", eventId: '1', actor: { id: 'roee', displayName: 'Roee', verified: true } });
  const offered = model.conversationRequests.flatMap(request => request.tools ?? []).map(tool => tool.name);
  assert.ok(offered.includes('missions_status'));
  assert.ok(!offered.includes('mission_status'));
});

test('someone else does not get another person\'s mission from another meeting', async () => {
  const { engine, model, missions } = await meetingWith(true);
  await engine.startSession('other', new DemoMeeting('o'));
  await engine.onUtterance('other', { text: "Nogita, what's left from what I asked?", eventId: '2', actor: { id: 'dana', displayName: 'Dana', verified: true } });
  const result = JSON.stringify(model.conversationRequests.at(-1)!.messages.at(-1)!.content);
  assert.match(result, /no mission I am working on/);
  assert.equal(missions.list().length, 1);
});
