import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { formatRecap, isRecapRequest, parseApproval, parseRecap, recapTranscript } from '../src/core/recap.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import type { ChatPort } from '../src/core/contracts.ts';
import { SlackWorkspace } from '../src/adapters/slack-workspace.ts';

const RECAP = JSON.stringify({
  decisions: ['Ship the board sync on Thursday'],
  actionItems: [{ what: 'Write the release notes', owner: 'Dana', due: 'Wednesday' }, { what: 'Fix the cache headers', owner: 'Roee' }],
  openQuestions: ['Who reviews the speech guard?'],
  proposedTasks: [{ title: 'Write the release notes', description: 'Dana, by Wednesday', owner: 'Dana' },
    { title: 'Fix the cache headers', description: 'Roee said he would', owner: 'Roee' },
    { title: 'Decide the speech guard reviewer', description: 'Open question' }],
});

test('parse, format and the words that ask for a recap or approve its tasks', () => {
  const recap = parseRecap(`Here: ${RECAP}`)!;
  assert.equal(recap.proposedTasks.length, 3);
  const text = formatRecap(recap, { final: false });
  assert.match(text, /Decisions:\n- Ship the board sync on Thursday/);
  assert.match(text, /Write the release notes \(Dana, Wednesday\)/);
  assert.match(text, /1\. Write the release notes \(Dana\)\n2\. Fix the cache headers \(Roee\)\n3\. Decide/);
  assert.match(text, /nothing is opened until approved/);
  assert.match(text, /Write "saved" and a number here before the meeting ends/);
  // Once the meeting is over nobody can approve by voice, and the bot cannot read a reply in its chat.
  const final = formatRecap(recap, { final: true });
  assert.match(final, /None of these was opened unless it says so/);
  assert.doesNotMatch(final, /next meeting|Write "saved"|Say "Nogita/);
  assert.equal(parseRecap('no json'), undefined);
  for (const ask of ['summarize', 'can you recap', 'wrap it up', 'sum it up please', 'תסכמי את הפגישה']) assert.equal(isRecapRequest(ask), true, ask);
  for (const ask of ['what did we decide about the summary page?', 'open a task']) assert.equal(isRecapRequest(ask), false, ask);
  assert.deepEqual(parseApproval('approve 1 and 3'), [1, 3]);
  assert.deepEqual(parseApproval('approve one, two'), [1, 2]);
  assert.equal(parseApproval('approve all'), 'all');
  assert.deepEqual(parseApproval('מאשר 2'), [2]);
  assert.equal(parseApproval('open a task for the cache'), undefined);
  assert.equal(parseApproval('approve the plan'), undefined);
  assert.equal(recapTranscript([{ text: 'Nogita: 16 PRs\n[What Nogita looked up: secret data]' }]), 'Nogita: 16 PRs');
});

class Model implements ChatModel {
  readonly agentModel = 'scripted';
  readonly recapRequests: string[] = [];
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const recap = request.stableSystem.startsWith('You write the recap');
    if (recap) this.recapRequests.push(String(request.messages[0]!.content));
    const text = recap ? RECAP : 'Sure.';
    onText(text);
    return { content: [{ type: 'text', text }] as AgentContent[], stopReason: 'end_turn' };
  }
}
class Meeting extends DemoMeeting {
  readonly chat: string[] = [];
  readonly spoken: string[] = [];
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
  override async speak(message: string): Promise<void> { this.spoken.push(message); await super.speak(message); }
}
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const guest = { id: 'guest', displayName: 'Guest', verified: false };

async function meeting(options: { recapChannel?: string; chat?: ChatPort } = {}) {
  const model = new Model();
  const board = new DemoBoard();
  const m = new Meeting('m');
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])),
    agent: model, people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]), ...(options.chat ? { chat: options.chat } : {}) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, meetingRecap: true, listenFirst: true,
    ...(options.recapChannel ? { recapChannel: options.recapChannel } : {}) });
  await engine.startSession('s', m);
  let n = 0;
  const say = (text: string, actor = roee) => engine.onUtterance('s', { text, eventId: String(++n), actor });
  for (let i = 0; i < 30; i++) await say(i % 2 ? 'Dana, can you write the release notes by Wednesday?' : 'I will fix the cache headers.');
  return { model, board, m, engine, say };
}

test('"Nogita, summarize": the recap in the chat from the whole meeting, and nothing opened', async () => {
  const f = await meeting();
  await f.say('Nogita, summarize.');
  assert.equal(f.board.tasks.length, 0);
  assert.match(f.m.chat.at(-1)!, /Proposed tasks \(nothing is opened until approved\)/);
  assert.equal(f.model.recapRequests[0]!.split('\n').filter(line => line.startsWith('Roee Angel:')).length >= 30, true, 'not only the last 24 lines');
});

test('"approve 1 and 3" opens exactly those, once; a guest cannot approve', async () => {
  const f = await meeting();
  await f.say('Nogita, summarize.');
  await f.say('Nogita, approve 1 and 3.', guest);
  assert.equal(f.board.tasks.length, 0);
  await f.say('Nogita, approve 1 and 3.');
  assert.deepEqual(f.board.tasks.map(task => task.title), ['Write the release notes', 'Decide the speech guard reviewer']);
  await f.say('Nogita, approve all.');
  assert.deepEqual(f.board.tasks.map(task => task.title), ['Write the release notes', 'Decide the speech guard reviewer', 'Fix the cache headers']);
  await f.say('Nogita, approve all.');
  assert.equal(f.board.tasks.length, 3, 'already open: nothing twice');
});

test('the end of the meeting posts the final recap; its tasks stay unopened', async () => {
  const f = await meeting();
  await f.engine.endSession('s');
  assert.equal(f.board.tasks.length, 0);
  assert.match(f.m.chat.at(-1)!, /^Meeting recap[\s\S]*None of these was opened/);
});

test('placeholders the model writes are dropped: "omit" owners, Nogita as owner, "Nothing was decided"', () => {
  const recap = parseRecap(JSON.stringify({ decisions: ['Nothing was decided in this meeting.'],
    actionItems: [{ what: 'Review the PRs', owner: 'omit', due: 'omit' }, { what: 'Summarize', owner: 'Nogita' }],
    openQuestions: [], proposedTasks: [{ title: 'Review the PRs', description: 'd', owner: 'none' }] }))!;
  assert.deepEqual(recap.decisions, []);
  assert.deepEqual(recap.actionItems, [{ what: 'Review the PRs' }, { what: 'Summarize' }]);
  assert.deepEqual(recap.proposedTasks, [{ title: 'Review the PRs', description: 'd' }]);
});

function slack(fail = false) {
  const posts: Array<{ channel: string; text: string }> = [];
  const chat: ChatPort = { name: 'Slack', listChannels: async () => [], readChannel: async () => [],
    postMessage: async (channel, text) => {
      if (fail) throw new Error('not_in_channel');
      posts.push({ channel, text });
      return { provider: 'slack', kind: 'message', label: channel, url: 'https://slack.example/1' };
    } };
  return { chat, posts };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('NOGITA_RECAP_CHANNEL: she was asked to leave: the recap goes to the meeting chat and the channel', async () => {
  const { chat, posts } = slack();
  const f = await meeting({ recapChannel: 'meeting-recaps', chat });
  await f.engine.endSession('s');
  assert.match(f.m.chat.at(-1)!, /^Meeting recap/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, 'meeting-recaps');
  assert.match(posts[0]!.text, /^Meeting s\nMeeting recap[\s\S]*Ship the board sync/);
});

test('a meeting that ended by itself, the usual ending, still gets its recap in the channel, and only there', async () => {
  const { chat, posts } = slack();
  const f = await meeting({ recapChannel: 'meeting-recaps', chat });
  const before = f.m.chat.length;
  await f.engine.endSession('s', false);
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(f.m.chat.length, before, 'the provider is gone: nothing is sent to the meeting');
  assert.ok(f.model.recapRequests[0]!.includes('Roee Angel:'), 'read the transcript, though the session is cleared');
  assert.equal(f.board.tasks.length, 0);
});

test('without a channel, a meeting that ended by itself costs no model call', async () => {
  const f = await meeting();
  await f.engine.endSession('s', false);
  await settle();
  assert.equal(f.model.recapRequests.length, 0);
});

test('the channel failing never breaks the meeting, and while she is there she says so', async () => {
  const { chat } = slack(true);
  const f = await meeting({ recapChannel: 'meeting-recaps', chat });
  await f.engine.endSession('s');
  assert.match(f.m.chat.at(-1)!, /could not save this recap to meeting-recaps/);
});

test('a channel id posts without listing channels, which needs only chat:write', async () => {
  const calls: string[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').at(-1)!;
    calls.push(method);
    if (method === 'chat.postMessage') assert.equal(JSON.parse(String(init?.body)).channel, 'C0123456789');
    return new Response(JSON.stringify({ ok: true, ts: '1.2', permalink: 'https://slack.example/1' }), { status: 200 });
  }) as typeof fetch;
  const receipt = await new SlackWorkspace('xoxb-test', undefined, http).postMessage('C0123456789', 'recap');
  assert.equal(calls.includes('conversations.list'), false);
  assert.ok(calls.includes('chat.postMessage'));
  assert.equal(receipt.url, 'https://slack.example/1');
});
