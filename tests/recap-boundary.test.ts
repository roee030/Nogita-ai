/**
 * P9-22: the recap channel is a team output, not system memory. Sending stays off without a configured channel, only the
 * recap goes there, participants are told, and earlier recaps reach a new meeting only through an explicitly enabled retro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { isArchivedRecap } from '../src/core/recap.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import type { ChatMessage, ChatPort } from '../src/core/contracts.ts';

const DECISION = 'Ship the board sync on Thursday';
const RECAP = JSON.stringify({ decisions: [DECISION], actionItems: [], openQuestions: [], proposedTasks: [] });
const SAID_ONLY_IN_THE_MEETING = 'the staging password lives in the old wiki';
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

/** Answers recaps with RECAP; `calls` scripts tool calls for ordinary turns, then "Sure." */
class Model implements ChatModel {
  readonly agentModel = 'scripted';
  readonly seen: string[] = [];
  readonly toolNames: string[][] = [];
  constructor(private readonly calls: Array<{ name: string; input: Record<string, unknown> }> = []) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    if (request.stableSystem.startsWith('You write the recap')) {
      onText(RECAP);
      return { content: [{ type: 'text', text: RECAP }] as AgentContent[], stopReason: 'end_turn' };
    }
    this.seen.push(JSON.stringify([request.stableSystem, request.turnSystem, request.messages]));
    this.toolNames.push(request.tools.map(tool => tool.name));
    const call = this.calls.shift();
    if (call) return { content: [{ type: 'tool_use', id: `t${this.calls.length}`, ...call }] as AgentContent[], stopReason: 'tool_use' };
    onText('Sure.');
    return { content: [{ type: 'text', text: 'Sure.' }] as AgentContent[], stopReason: 'end_turn' };
  }
}

class Meeting extends DemoMeeting {
  readonly chat: string[] = [];
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
}

/** A channel that keeps what is posted, as Slack does, with a person's message beside it. */
function slack() {
  const messages: ChatMessage[] = [{ channel: 'meeting-recaps', author: 'Dana', at: '2026-11-06 09:00', text: 'I liked the last meeting recap.' }];
  let reads = 0;
  const chat: ChatPort = { name: 'Slack', listChannels: async () => [],
    readChannel: async () => { reads++; return messages; },
    searchMessages: async () => messages,
    postMessage: async (channel, text) => {
      messages.push({ channel, author: 'Nogita', at: '2026-11-06 10:00', text });
      return { provider: 'slack', kind: 'message', label: channel, url: 'https://slack.example/1' };
    } };
  return { chat, messages, reads: () => reads };
}

const posted = (messages: readonly ChatMessage[]) => messages.filter(message => message.author === 'Nogita');

function engine(model: Model, options: { recapChannel?: string; chat?: ChatPort; retro?: boolean } = {}) {
  return new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])),
    agent: model, ...(options.chat ? { chat: options.chat } : {}) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, meetingRecap: true,
    ...(options.retro ? { retro: true } : {}), ...(options.recapChannel ? { recapChannel: options.recapChannel } : {}) });
}

let events = 0;
async function holdMeeting(nogita: NogitaEngine, id: string, lines: string[] = ['Nogita, what is next?', `Dana said ${SAID_ONLY_IN_THE_MEETING}.`]) {
  const meeting = new Meeting(id);
  await nogita.startSession(id, meeting);
  for (const text of lines) await nogita.onUtterance(id, { text, eventId: String(++events), actor: roee });
  await settle();
  return meeting;
}

test('meeting memory off does not stop the recap from reaching the channel', async () => {
  const { chat, messages } = slack();
  const model = new Model();
  const nogita = engine(model, { recapChannel: 'meeting-recaps', chat });
  await holdMeeting(nogita, 'a');
  await nogita.endSession('a', false);
  await settle();
  assert.equal(posted(messages).length, 1);
  assert.ok(!model.toolNames.flat().includes('past_decisions'), 'no memory: nothing to look up across meetings');
});

test('without a configured channel nothing is sent, and nobody is told otherwise', async () => {
  const { chat, messages } = slack();
  const nogita = engine(new Model(), { chat });
  const meeting = await holdMeeting(nogita, 'a');
  await nogita.endSession('a');
  await settle();
  assert.equal(posted(messages).length, 0);
  assert.ok(!meeting.chat.some(message => /saved/.test(message) && /Slack/.test(message)));
});

test('only the recap is sent: what was said stays out of the channel', async () => {
  const { chat, messages } = slack();
  const nogita = engine(new Model(), { recapChannel: 'meeting-recaps', chat });
  await holdMeeting(nogita, 'a');
  await nogita.endSession('a', false);
  await settle();
  const [post] = posted(messages);
  assert.match(post!.text, new RegExp(DECISION));
  assert.doesNotMatch(post!.text, new RegExp(SAID_ONLY_IN_THE_MEETING));
  assert.ok(isArchivedRecap(post!.text));
});

test('participants are told once that the recap is saved in Slack, and that it is not a recording or transcript', async () => {
  const { chat } = slack();
  const meeting = await holdMeeting(engine(new Model(), { recapChannel: 'meeting-recaps', chat }), 'a');
  const notices = meeting.chat.filter(message => /recap of this meeting will be saved/i.test(message));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Slack/);
  assert.match(notices[0]!, /not a recording or a full transcript/);
});

test('earlier recaps do not enter the context of a new meeting', async () => {
  const { chat, reads } = slack();
  const model = new Model();
  const nogita = engine(model, { recapChannel: 'meeting-recaps', chat });
  await holdMeeting(nogita, 'first');
  await nogita.endSession('first', false);
  await settle();
  const readsBefore = reads();
  model.seen.length = 0;
  await holdMeeting(nogita, 'second', ['Nogita, what is next?']);
  assert.ok(model.seen.length > 0);
  assert.ok(!model.seen.some(text => text.includes(DECISION)));
  assert.equal(reads(), readsBefore, 'nothing read the channel on its own');
});

for (const tool of [{ name: 'read_channel', input: { channel: 'meeting-recaps' } }, { name: 'search_messages', input: { query: 'board sync' } }]) {
  test(`${tool.name} leaves out archived recaps, and keeps what people wrote`, async () => {
    const { chat } = slack();
    const model = new Model();
    const nogita = engine(model, { recapChannel: 'meeting-recaps', chat });
    await holdMeeting(nogita, 'first');
    await nogita.endSession('first', false);
    await settle();
    model.seen.length = 0;
    model['calls'].push(tool);
    await holdMeeting(nogita, 'second', ['Nogita, check the channel.']);
    const after = model.seen.join('\n');
    assert.match(after, /I liked the last meeting recap/);
    assert.ok(!after.includes(DECISION));
    assert.match(after, /left out/);
  });
}

test('retro off: asking for a retro does not read the recaps', async () => {
  const { chat, reads } = slack();
  await holdMeeting(engine(new Model(), { recapChannel: 'meeting-recaps', chat }), 'a', ['Nogita, prepare the retro.']);
  assert.equal(reads(), 0);
});

test('retro on: an explicit request reads the recaps', async () => {
  const { chat, reads } = slack();
  await holdMeeting(engine(new Model(), { recapChannel: 'meeting-recaps', chat, retro: true }), 'a', ['Nogita, prepare the retro.']);
  assert.equal(reads(), 1);
});

test('what counts as an archived recap: her own posts, not a person mentioning one', () => {
  assert.ok(isArchivedRecap('Meeting meet-1\nMeeting recap\n\nDecisions:\n- x'));
  assert.ok(isArchivedRecap('Retro, last 14 days, from 3 meetings\nClosed: x'));
  assert.ok(!isArchivedRecap('I liked the last meeting recap.'));
  assert.ok(!isArchivedRecap('Meeting tomorrow, please read the Meeting recap first'));
});
