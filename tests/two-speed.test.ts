import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse, ToolOutcome } from '../src/core/agent.ts';
import { MemoryMissionStore, MissionRunner } from '../src/core/missions.ts';
import { NogitaEngine, researchAck, type NogitaEngineOptions, type QuestionEvent } from '../src/core/engine.ts';
import { matchResearchTemplate } from '../src/core/research-templates.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { twoSpeed } from '../src/app/config.ts';

const use = (name: string, input: Record<string, unknown>): AgentContent =>
  ({ type: 'tool_use', id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, input });
const say = (text: string): AgentContent => ({ type: 'text', text });
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await tick(10);
}

/** Mission rounds in order (each may wait for `hold`); conversation turns answer in one line. */
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly turns: ChatModelRequest[] = [];
  hold?: Promise<void>;
  constructor(private readonly rounds: AgentContent[][]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (!request.usageContext?.startsWith('mission:')) {
      // Topic naming has no tools; a conversation turn has them.
      if (!request.tools.length) return { content: [say("today's commits")], stopReason: 'end_turn' };
      this.turns.push(request);
      onText('Two commits landed.');
      return { content: [say('Two commits landed.')], stopReason: 'end_turn' };
    }
    await this.hold;
    const round = this.rounds.shift() ?? [say('Nothing more.')];
    return { content: round, stopReason: round.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}

function tools(): AgentToolbox {
  const handlers: Record<string, () => ToolOutcome> = {
    repo_activity: () => ({ content: 'Today: 2 commits\n37d6053 fix: follow-ups keep their speaker (Dana)\n9b1c2aa feat: ci_status tool (Roee)' }),
  };
  return {
    specs: Object.keys(handlers).map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } })),
    isWrite: () => false,
    async run(name) { return handlers[name]?.() ?? { content: 'unknown tool', isError: true }; },
  };
}

const RESEARCH_ROUNDS = (): AgentContent[][] => [
  [use('repo_activity', { period: 'today' })],
  [use('finish_mission', { summary: 'Two commits landed today: a fix so follow-ups keep their speaker, and the ci_status tool.',
    evidence: ['37d6053', '9b1c2aa'] })],
];

function rig(options: { twoSpeed?: boolean; rounds?: AgentContent[][]; floor?: NogitaEngineOptions['floor'] } = {}) {
  const model = new ScriptedModel(options.rounds ?? RESEARCH_ROUNDS());
  const notes: string[] = [];
  const runner = new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: () => tools(),
    notify: (_mission, text) => { notes.push(text); }, newId: (() => { let n = 0; return () => `M-R${++n}`; })() });
  const events: QuestionEvent[] = [];
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
  { missions: runner, twoSpeed: options.twoSpeed ?? true, schedule: () => 0, cancel: () => undefined,
    floor: options.floor ?? { talkingMs: 20, resumeAfterMs: 20 }, onQuestion: (_s, event) => events.push(event) });
  const spoken = () => meeting.events.filter(event => event.type === 'speak').map(event => event.text!);
  const chat = () => meeting.events.filter(event => event.type === 'chat').map(event => event.text!);
  return { model, runner, notes, events, meeting, engine, spoken, chat };
}
const roee = { id: 'roee', displayName: 'Roee', verified: true };

test('the short answer names what she is checking', () => {
  assert.equal(researchAck(matchResearchTemplate('what landed today?')!), "Checking today's commits. I'll tell you when I have it.");
  assert.equal(researchAck(matchResearchTemplate('what changed this week?')!), "Checking this week's commits. I'll tell you when I have it.");
  assert.equal(researchAck(matchResearchTemplate('why did the deploy fail?')!), "Looking into what broke. I'll tell you when I have it.");
  assert.equal(researchAck(matchResearchTemplate('which tickets are still open on checkout?')!), "Checking the open tasks. I'll tell you when I have it.");
});

test('a research question gets a short spoken answer at once and the full answer from a background mission', async () => {
  const f = rig();
  await f.engine.startSession('s', f.meeting);
  const result = await f.engine.onUtterance('s', { text: 'Nogita, what landed today?', eventId: '1', actor: roee });
  assert.equal(result, 'answered');
  // Spoken before the research is done, and no one-shot answer was attempted.
  assert.deepEqual(f.spoken(), ["Checking today's commits. I'll tell you when I have it."]);
  assert.equal(f.model.turns.length, 0);
  const [mission] = f.runner.list();
  assert.equal(mission!.research, true);
  assert.equal(mission!.sessionId, 's');
  assert.equal(mission!.owner.id, 'roee');
  assert.ok(f.events.some(event => event.status === 'answered' && event.detail === `short answer; ${mission!.id} researches the full answer`));

  await f.runner.idle();
  await tick(80);
  assert.equal(f.runner.get(mission!.id)!.status, 'done');
  // The full answer: in chat whole, spoken at the opening with its topic first, and no extra "M-R1 done" line.
  assert.ok(f.chat().some(text => /Two commits landed today: a fix so follow-ups keep their speaker, and the ci_status tool\./.test(text)));
  assert.equal(f.spoken().length, 2);
  assert.match(f.spoken()[1]!, /^About today's commits, two commits landed today/i);
  assert.deepEqual(f.notes, []);
  assert.ok(f.events.some(event => event.status === 'answered' && event.detail === `full answer from ${mission!.id} spoken`));
});

test('the full answer is not spoken over people: with no opening it stays in chat', async () => {
  const f = rig({ floor: { talkingMs: 10_000, resumeAfterMs: 20, maxWaitMs: 60 } });
  let open!: () => void;
  f.model.hold = new Promise(resolve => { open = resolve; });
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Nogita, what landed today?', eventId: '1', actor: roee });
  assert.equal(f.spoken().length, 1);
  // Dana starts talking while the research runs, and keeps talking.
  f.engine.noteVoice('s', 'dana');
  open();
  await f.runner.idle();
  // The floor checks again about once a second until its wait runs out.
  await until(() => f.events.some(event => event.status === 'chat_only'));
  assert.equal(f.spoken().length, 1);
  assert.ok(f.chat().some(text => /Two commits landed today/.test(text)));
  assert.ok(f.events.some(event => event.status === 'chat_only' && /full answer from M-R1 in chat \(dropped\)/.test(event.detail ?? '')));
});

test('when the meeting ended before the research did, the answer goes out as the mission\'s progress line', async () => {
  const f = rig();
  let open!: () => void;
  f.model.hold = new Promise(resolve => { open = resolve; });
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Nogita, what landed today?', eventId: '1', actor: roee });
  await f.engine.endSession('s');
  open();
  await f.runner.idle();
  assert.deepEqual(f.notes, ['Roee asked "what landed today?": Two commits landed today: a fix so follow-ups keep their speaker, and the ci_status tool.']);
});

test('with the flag off, or for a question that needs no research, she answers in one turn', async () => {
  for (const [flag, text] of [[false, 'Nogita, what landed today?'], [true, 'Nogita, how are you?']] as const) {
    const f = rig({ twoSpeed: flag });
    await f.engine.startSession('s', f.meeting);
    await f.engine.onUtterance('s', { text, eventId: '1', actor: roee });
    assert.equal(f.model.turns.length, 1, text);
    assert.deepEqual(f.runner.list(), []);
    assert.deepEqual(f.spoken(), ['Two commits landed.']);
  }
});

test('someone without access gets no background research', async () => {
  const f = rig();
  await f.engine.startSession('s', f.meeting);
  await f.engine.onUtterance('s', { text: 'Nogita, what landed today?', eventId: '1', actor: { id: 'guest', displayName: 'Guest', verified: true } });
  assert.deepEqual(f.runner.list(), []);
  assert.ok(!f.spoken().some(text => /^Checking/.test(text)));
});

test('NOGITA_TWO_SPEED is off unless true', () => {
  assert.equal(twoSpeed({}), false);
  assert.equal(twoSpeed({ NOGITA_TWO_SPEED: 'false' }), false);
  assert.equal(twoSpeed({ NOGITA_TWO_SPEED: 'true' }), true);
  assert.throws(() => twoSpeed({ NOGITA_TWO_SPEED: 'yes' }), /must be true or false/);
});
