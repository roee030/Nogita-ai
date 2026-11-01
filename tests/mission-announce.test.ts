import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, AgentToolbox, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { MemoryMissionStore, MissionRunner } from '../src/core/missions.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { briefly } from '../src/core/spoken.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const use = (name: string, input: Record<string, unknown>): AgentContent => ({ type: 'tool_use', id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, input });
const say = (text: string): AgentContent => ({ type: 'text', text });

const LONG = 'The Slack replay failed because the bot token expired on Tuesday. KAN-1 is owned by Dana and is still in progress. ' +
  'The code in src/app/slack-socket.ts does not refresh the token, so it fails again after twelve hours. I opened KAN-41 for the refresh. ' +
  'Sources: https://jira.example/browse/KAN-1 https://jira.example/browse/KAN-41';

test('briefly keeps the first sentence or two, spoken, and says the rest is in chat', () => {
  assert.equal(briefly(LONG), 'The Slack replay failed because the bot token expired on Tuesday. KAN 1 is owned by Dana and is still in progress. The details are in the chat.');
  assert.equal(briefly('Done: KAN-7 is open.'), 'Done: KAN 7 is open.');
  const runOn = `${'word '.repeat(60).trim()}.`;
  assert.match(briefly(runOn), /^(?:word ){39}word… The details are in the chat\.$/i);
});

class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly toolResults: string[] = [];
  private rounds: AgentContent[][] = [[use('get_task', { key: 'KAN-1' })], [use('finish_mission', { summary: LONG, evidence: ['KAN-1'] })]];
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.usageContext?.startsWith('mission:')) {
      const round = this.rounds.shift() ?? [say('Done.')];
      return { content: round, stopReason: round.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    }
    const last = request.messages.at(-1)!;
    if (last.role === 'user' && typeof last.content !== 'string') {
      for (const block of last.content) if (block.type === 'tool_result') this.toolResults.push(String(block.content));
      onText('One thing is open: the token refresh.');
      return { content: [say('One thing is open: the token refresh.')], stopReason: 'end_turn' };
    }
    return { content: [use('mission_status', {})], stopReason: 'tool_use' };
  }
}

const tools = (): AgentToolbox => ({
  specs: [{ name: 'get_task', description: 'get_task', input_schema: { type: 'object', properties: {} } }],
  isWrite: () => false,
  async run() { return { content: 'KAN-1: Slack replay fails, owner Dana https://jira.example/browse/KAN-1' }; },
});

async function meeting(shortSpokenResults: boolean) {
  const model = new ScriptedModel();
  const meeting = new DemoMeeting('m');
  let engine: NogitaEngine | undefined;
  const missions = new MissionRunner({ model, store: new MemoryMissionStore(), toolbox: tools,
    notify: (mission, text) => { void engine!.announce(mission.sessionId!, text); } });
  engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model },
  { missions, missionStatus: true, shortSpokenResults, schedule: () => 0, cancel: () => undefined, floor: { talkingMs: 20, resumeAfterMs: 20 } });
  await engine.startSession('s', meeting);
  await missions.start({ goal: 'Take care of the Slack replay failure', owner: { id: 'roee', displayName: 'Roee' }, sessionId: 's' });
  await missions.idle();
  await new Promise(resolve => setTimeout(resolve, 80));
  const spoken = () => meeting.events.filter(event => event.type === 'speak').map(event => event.text!).join(' ');
  const chat = () => meeting.events.filter(event => event.type === 'chat').map(event => event.text!).join('\n');
  return { model, engine, meeting, spoken, chat };
}

test('a mission\'s result is spoken in a sentence or two; the whole result is in chat', async () => {
  const { spoken, chat } = await meeting(true);
  assert.match(spoken(), /bot token expired on Tuesday\. KAN 1 is owned by Dana and is still in progress\. The details are in the chat\./);
  assert.doesNotMatch(spoken(), /KAN 41|twelve hours/);
  assert.match(chat(), /I opened KAN-41 for the refresh/);
});

test('without the flag the whole result is spoken, as before', async () => {
  const { spoken } = await meeting(false);
  assert.match(spoken(), /I opened KAN 41 for the refresh/);
});

test('in a voice meeting, mission_status posts the full report to chat and asks for a short spoken answer', async () => {
  const { model, engine, chat } = await meeting(true);
  await engine.onUtterance('s', { text: "Nogita, what's left from what I asked?", eventId: '1', actor: { id: 'roee', displayName: 'Roee', verified: true } });
  const result = model.toolResults.at(-1)!;
  assert.match(result, /This full report is now in the meeting chat\./);
  assert.match(result, /Answer aloud in one or two short sentences/);
  assert.match(chat(), /\[done\] Take care of the Slack replay failure\nDone:/);
});

test('without the flag mission_status is unchanged', async () => {
  const { model, engine, chat } = await meeting(false);
  await engine.onUtterance('s', { text: "Nogita, what's left from what I asked?", eventId: '1', actor: { id: 'roee', displayName: 'Roee', verified: true } });
  assert.doesNotMatch(model.toolResults.at(-1)!, /Answer aloud/);
  assert.doesNotMatch(chat(), /\[done\] Take care/);
});
