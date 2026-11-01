import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse, ToolOutcome } from '../src/core/agent.ts';
import { MemoryMissionStore, MissionRunner, verifiedEvidence, type Mission, type MissionStore } from '../src/core/missions.ts';
import { FileMissionStore } from '../src/app/mission-store.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

type Round = AgentContent[] | Error;
const use = (name: string, input: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 7)}`): AgentContent =>
  ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentContent => ({ type: 'text', text });

/** Plays the mission's model rounds in order; conversation turns (not missions) get `conversation`. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly missionRequests: ChatModelRequest[] = [];
  constructor(private readonly rounds: Round[], private readonly conversation: (request: ChatModelRequest) => AgentContent[] = () => []) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (!request.usageContext?.startsWith('mission:')) {
      const content = this.conversation(request);
      for (const block of content) if (block.type === 'text') onText(block.text);
      return { content, stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    }
    this.missionRequests.push(structuredClone(request));
    const round = this.rounds.shift();
    if (!round) return { content: [say('Nothing more.')], stopReason: 'end_turn' };
    if (round instanceof Error) throw round;
    return { content: round, stopReason: round.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}

/** A board with KAN-20 blocked on KAN-31; create_task is a write. */
function fakeTools(log: string[]): AgentToolbox {
  const created: string[] = [];
  const handlers: Record<string, (input: Record<string, unknown>) => ToolOutcome> = {
    get_task: input => input.key === 'KAN-20'
      ? { content: 'KAN-20: Checkout page shows stale prices\nStatus: Blocked\nComments:\n- Dana: waiting for KAN-31 (price API cache headers)' }
      : input.key === 'KAN-31' ? { content: 'KAN-31: Price API cache headers\nStatus: To Do\nAssignee: unassigned' }
      : created.includes(String(input.key)) ? { content: `${String(input.key)}: Follow-up\nStatus: To Do` } : { content: 'not found', isError: true },
    search_code: () => ({ content: 'src/api/prices.ts\nhttps://github.example/prices.ts\nres.setHeader("Cache-Control", "max-age=3600")' }),
    create_task: input => { const key = `KAN-${40 + created.length}`; created.push(key); return { content: `Created ${key}: ${String(input.title)} https://jira.example/${key}` }; },
  };
  return {
    specs: Object.keys(handlers).map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } })),
    isWrite: name => name === 'create_task',
    async run(name, input) { log.push(name); return handlers[name]?.(input) ?? { content: 'unknown tool', isError: true }; },
  };
}

function rig(rounds: Round[], store: MissionStore = new MemoryMissionStore(), prefix = 'T',
  schedule: (work: () => void, ms: number) => unknown = (work, ms) => setTimeout(work, Math.min(ms, 5))) {
  const model = new ScriptedModel(rounds);
  const calls: string[] = [];
  const notes: string[] = [];
  const runner = new MissionRunner({ model, store, toolbox: () => fakeTools(calls), notify: (_m, text) => { notes.push(text); },
    schedule, newId: (() => { let n = 0; return () => `M-${prefix}${++n}`; })() });
  return { model, runner, calls, notes, store };
}
const owner = { id: 'roee', displayName: 'Roee' };

test('evidence counts only when one of the mission\'s own tool results contained it', () => {
  const messages = [{ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'a', content: 'KAN-31: Price API' }] }];
  assert.deepEqual(verifiedEvidence(messages, ['KAN-31', 'KAN-99']), { found: ['KAN-31'], missing: ['KAN-99'] });
  const commits = [{ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'b', content: '37d6053 fix: she answers follow-ups\nsrc/core/engine.ts' }] }];
  // Identifiers inside a phrase count; a claim with no identifier must match as written.
  assert.deepEqual(verifiedEvidence(commits, ['commit 37d6053', 'src/core/engine.ts (the engine)', 'commit 1234567', 'tests pass']),
    { found: ['commit 37d6053', 'src/core/engine.ts (the engine)'], missing: ['commit 1234567', 'tests pass'] });
});

test('a mission investigates on its own, records what it found, and finishes only with verified evidence', async () => {
  const f = rig([
    [say('Checking KAN-20.'), use('get_task', { key: 'KAN-20' }), use('search_code', { query: 'price cache' })],
    [use('record_finding', { finding: 'KAN-20 is blocked by KAN-31 (cache headers on the price API).' }), use('get_task', { key: 'KAN-31' })],
    // A claim without proof is refused...
    [use('finish_mission', { summary: 'Fixed.', evidence: ['PR #12'] })],
    // ...one grounded in tool results is accepted.
    [use('finish_mission', { summary: 'The blocker is KAN-31, unassigned; cache headers in src/api/prices.ts.', evidence: ['KAN-31', 'src/api/prices.ts'] })],
  ]);
  const mission = await f.runner.start({ goal: 'Take care of KAN-20: find what blocks it', owner, sessionId: 's1' });
  assert.equal(mission.status, 'investigating');
  await f.runner.idle();
  const done = f.runner.get(mission.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result?.evidence, ['KAN-31', 'src/api/prices.ts']);
  assert.deepEqual(f.calls, ['get_task', 'search_code', 'get_task']);
  const kinds = done.steps.map(step => step.kind);
  assert.ok(kinds.includes('finding') && kinds.includes('verification_failed') && kinds.at(-1) === 'finished', kinds.join());
  assert.match(f.notes.at(-1)!, /^M-T1 done: The blocker is KAN-31/);
});

test('a write waits for the owner; only the owner can approve; it runs once and the mission goes on', async () => {
  const f = rig([
    [use('get_task', { key: 'KAN-20' })],
    [use('create_task', { title: 'Add cache headers to the price API', assignee: 'Dana' }, 'write-1')],
    [use('get_task', { key: 'KAN-40' })],
    [use('finish_mission', { summary: 'Opened KAN-40 for the price API headers.', evidence: ['KAN-40'] })],
  ]);
  const mission = await f.runner.start({ goal: 'Move KAN-20 forward', owner });
  await f.runner.idle();
  const waiting = f.runner.get(mission.id)!;
  assert.equal(waiting.status, 'awaiting_approval');
  assert.match(waiting.pending!.summary, /create the task "Add cache headers to the price API" for Dana/);
  assert.ok(!f.calls.includes('create_task'), 'nothing written before approval');
  assert.match(f.notes.at(-1)!, /approve or decline/);
  assert.equal((await f.runner.approve(mission.id, 'dana')).ok, false);
  assert.equal((await f.runner.approve(mission.id, 'roee')).ok, true);
  await f.runner.idle();
  assert.equal(f.calls.filter(name => name === 'create_task').length, 1);
  assert.equal(f.runner.get(mission.id)!.status, 'done');
  assert.equal((await f.runner.approve(mission.id, 'roee')).ok, false, 'no second approval of the same action');
});

test('a declined write is not retried; the mission continues without it', async () => {
  const f = rig([
    [use('create_task', { title: 'Something' })],
    [use('report_blocked', { reason: 'The owner declined the follow-up task.', needs: 'a decision on who fixes KAN-31' })],
  ]);
  const mission = await f.runner.start({ goal: 'Handle KAN-20', owner });
  await f.runner.idle();
  await f.runner.reject(mission.id, 'roee', 'Not now.');
  await f.runner.idle();
  const after = f.runner.get(mission.id)!;
  assert.equal(after.status, 'blocked');
  assert.ok(!f.calls.includes('create_task'));
  const declined = f.model.missionRequests.at(-1)!.messages.at(-1)!;
  assert.match(JSON.stringify(declined.content), /Not now\. Do not retry/);
});

test('missions survive a restart: working ones resume from disk, one awaiting approval keeps waiting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-missions-'));
  try {
    const first = rig([
      [use('get_task', { key: 'KAN-20' })],
      new Error('server stopped'),
      // The process is gone: its retry never runs. A live retry here raced the new process for the same file.
    ], new FileMissionStore(directory), 'T', () => undefined);
    const waiting = rig([[use('create_task', { title: 'Follow-up' })]], new FileMissionStore(directory), 'W');
    const working = await first.runner.start({ goal: 'Investigate KAN-20', owner });
    const approval = await waiting.runner.start({ goal: 'Open a follow-up', owner });
    await first.runner.idle(); await waiting.runner.idle();
    // A new process: the same store, a fresh runner.
    const second = rig([[use('finish_mission', { summary: 'KAN-20 waits on KAN-31.', evidence: ['KAN-31'] })]], new FileMissionStore(directory), 'S');
    // The evidence must come from this mission's own results: the first round's get_task result is on disk.
    const resumed = await second.runner.resumeAll();
    assert.equal(resumed, 1);
    await second.runner.idle();
    assert.equal(second.runner.get(working.id)!.status, 'done');
    assert.ok(second.runner.get(working.id)!.steps.some(step => step.kind === 'resumed'));
    assert.equal(second.runner.get(approval.id)!.status, 'awaiting_approval');
    assert.equal((await new FileMissionStore(directory).load(working.id))?.status, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verified owner guidance from a handoff thread is persisted into the same active mission before resume', async () => {
  const store = new MemoryMissionStore();
  const mission: Mission = { id: 'M-GUIDE', goal: 'Investigate KAN-20', doneWhen: 'Find the blocker', owner,
    sessionId: 'meet:daily', status: 'investigating', createdAt: 1, updatedAt: 1, attempts: 0, rounds: 0,
    steps: [{ at: 1, kind: 'started', text: 'Started' }], messages: [{ role: 'user', content: 'Mission' }] };
  await store.save(mission);
  const f = rig([[use('report_blocked', { reason: 'done reading guidance' })]], store);
  await f.runner.loadAll();

  assert.equal((await f.runner.guide('M-GUIDE', 'other', 'ignore this')).ok, false);
  assert.equal((await f.runner.guide('M-GUIDE', 'roee', 'also check the Slack reconnect logs')).ok, true);
  assert.equal(await f.runner.resumeAll(), 1);
  await f.runner.idle();

  assert.match(JSON.stringify(f.model.missionRequests[0]!.messages), /also check the Slack reconnect logs/);
  assert.match(JSON.stringify((await store.load('M-GUIDE'))!.messages), /also check the Slack reconnect logs/);
});

test('guidance arriving during a model round preempts that stale round before it can block the mission', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const requests: ChatModelRequest[] = [];
  const model: ChatModel = { agentModel: 'deferred', async streamChat(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) { entered(); await gate; }
    return { content: [use('report_blocked', { reason: 'stale blocker' })], stopReason: 'tool_use' };
  } };
  const runner = new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: () => fakeTools([]), newId: () => 'M-RACE' });
  await runner.start({ goal: 'Investigate KAN-20', owner });
  await started;

  assert.equal((await runner.guide('M-RACE', 'roee', 'check the reconnect log first')).ok, true);
  release();
  await runner.idle();

  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0]!.messages), /reconnect log/);
  assert.match(JSON.stringify(requests[1]!.messages), /check the reconnect log first/);
});

test('guidance arriving during a slow read preempts the rest of that tool round', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reading!: () => void;
  const readStarted = new Promise<void>(resolve => { reading = resolve; });
  const requests: ChatModelRequest[] = [];
  const model: ChatModel = { agentModel: 'slow-read', async streamChat(request) {
    requests.push(structuredClone(request));
    return requests.length === 1
      ? { content: [use('get_task', { key: 'KAN-20' }, 'read'), use('report_blocked', { reason: 'stale blocker' }, 'block')], stopReason: 'tool_use' }
      : { content: [use('report_blocked', { reason: 'new blocker' })], stopReason: 'tool_use' };
  } };
  const toolbox: AgentToolbox = { specs: [{ name: 'get_task', description: '', input_schema: { type: 'object', properties: {} } }],
    isWrite: () => false, async run() { reading(); await gate; return { content: 'KAN-20 exists' }; } };
  const runner = new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: () => toolbox, newId: () => 'M-SLOW' });
  await runner.start({ goal: 'Investigate KAN-20', owner });
  await readStarted;

  assert.equal((await runner.guide('M-SLOW', 'roee', 'check Slack first')).ok, true);
  release();
  await runner.idle();

  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]!.messages), /check Slack first/);
  assert.equal(runner.get('M-SLOW')!.blockedReason, 'new blocker');
});

test('a write interrupted by a restart is never repeated blindly', async () => {
  const store = new MemoryMissionStore();
  const mission: Mission = { id: 'M-CRASH', goal: 'g', doneWhen: 'd', owner, status: 'executing', createdAt: 0, updatedAt: 0, attempts: 0,
    rounds: 1, steps: [{ at: 0, kind: 'write_started', text: 'create the task "x"', tool: 'create_task' }],
    messages: [{ role: 'user', content: 'Mission' }, { role: 'assistant', content: [use('create_task', { title: 'x' }, 'w1')] }] };
  await store.save(mission);
  const f = rig([[use('get_task', { key: 'KAN-20' })], [use('report_blocked', { reason: 'stop here' })]], store);
  await f.runner.resumeAll();
  await f.runner.idle();
  const repaired = JSON.stringify(f.model.missionRequests[0]!.messages.at(-1)!.content);
  assert.match(repaired, /may or may not have happened\. Check with a read tool/);
  assert.ok(!f.calls.includes('create_task'));
});

test('model failures are retried a bounded number of times, then the mission fails and says so', async () => {
  const f = rig([new Error('overloaded'), new Error('overloaded'), new Error('overloaded')]);
  const mission = await f.runner.start({ goal: 'Look into KAN-20', owner });
  for (let i = 0; i < 40 && f.runner.get(mission.id)!.status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.runner.get(mission.id)!.status, 'failed');
  assert.match(f.notes.at(-1)!, /stopped/);
});

test('in a meeting: "take care of KAN-20" starts a mission with one short line; "approve" lets it continue', async () => {
  const model = new ScriptedModel([
    [use('create_task', { title: 'Price API cache headers' })],
    [use('get_task', { key: 'KAN-40' })],
    [use('finish_mission', { summary: 'Opened KAN-40.', evidence: ['KAN-40'] })],
  ], request => {
    const said = String(request.messages[0]?.content ?? '').split('says to you now:').at(-1) ?? '';
    const answered = request.messages.some(message => message.role === 'assistant');
    if (/take care of KAN-20/.test(said)) return answered ? [say("On it. I'll check what's blocking it.")] : [use('delegate_mission', { goal: 'Take care of KAN-20' })];
    if (/approve/i.test(said)) return answered ? [say('Approved.')] : [use('decide_mission', { decision: 'approve' })];
    return [];
  });
  const calls: string[] = [];
  const runner = new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: () => fakeTools(calls),
    notify: (mission, text) => { void engine.announce(mission.sessionId!, text); } });
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
  { missions: runner, schedule: () => 0, cancel: () => undefined, floor: { talkingMs: 20, resumeAfterMs: 20 } });
  await engine.startSession('s', meeting);
  const roee = { id: 'roee', displayName: 'Roee', verified: true };
  await engine.onUtterance('s', { text: 'Nogita, take care of KAN-20.', eventId: '1', actor: roee });
  const spoken = () => meeting.events.filter(event => event.type === 'speak').map(event => event.text);
  assert.equal(spoken().join(' '), "On it. I'll check what's blocking it.");
  await runner.idle();
  const [mission] = runner.list();
  assert.equal(mission!.status, 'awaiting_approval');
  assert.equal(mission!.sessionId, 's');
  // The approval request reached the meeting (chat, and spoken at an opening).
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(meeting.events.some(event => event.type === 'chat' && /approve or decline/.test(event.text ?? '')));
  await engine.onUtterance('s', { text: 'Nogita, approve it.', eventId: '2', actor: roee });
  await runner.idle();
  assert.equal(runner.get(mission!.id)!.status, 'done');
  assert.equal(calls.filter(name => name === 'create_task').length, 1);
});
