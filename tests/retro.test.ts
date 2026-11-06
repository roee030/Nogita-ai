import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetroRequest, recapsSince, retroDays, retroInput } from '../src/core/retro.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import type { ChatMessage, ChatPort } from '../src/core/contracts.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const recap = (at: string, text: string): ChatMessage => ({ channel: 'meeting-recaps', author: 'a bot', at, text: `Meeting x\nMeeting recap\n\nDecisions:\n- ${text}` });

test('the words that ask for a retro, its period, and which messages are recaps', () => {
  for (const ask of ['prepare the retro', 'can you write a retrospective for this week?', 'retro for the last 10 days', 'תכיני רטרו'])
    assert.equal(isRetroRequest(ask), true, ask);
  for (const ask of ['what is a retro lens?', 'open a task for the retry worker', 'what landed today?'])
    assert.equal(isRetroRequest(ask), false, ask);
  assert.equal(retroDays('prepare the retro'), 14);
  assert.equal(retroDays('retro for this week'), 7);
  assert.equal(retroDays('retro for the last 10 days'), 10);
  assert.equal(retroDays('retro for the last three weeks'), 21);
  assert.equal(retroDays('retro for the last 90 days'), 60);
  const found = recapsSince([recap('2026-11-05 09:00', 'Ship it'), recap('2026-10-01 09:00', 'Too old'),
    { channel: 'c', author: 'Dana', at: '2026-11-05 10:00', text: 'lunch?' }], NOW - 14 * 86_400_000);
  assert.deepEqual(found.map(item => item.at), ['2026-11-05 09:00']);
});

test('the model gets the data, each piece labelled, and says when a source could not be read', () => {
  const text = retroInput({ days: 7, recaps: [recap('2026-11-05 09:00', 'Ship it')], tasks: [{ key: 'KAN-24', title: 'Review PRs', status: 'To Do', url: 'u' }] });
  assert.match(text, /last 7 days/);
  assert.match(text, /\[2026-11-05 09:00\]/);
  assert.match(text, /KAN-24 Review PRs \(To Do, nobody\)/);
  assert.match(text, /Merged pull requests:\n\(none, or the repository could not be read\)/);
});

class Model implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(request);
    const text = 'One release shipped and the cache fix is stuck. Closed: board sync (5 Nov). Stuck: KAN-24.';
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
const roee = { id: 'roee', displayName: 'Roee', verified: true };
// Verified but not on the allowlist: an unverified speaker is ignored before any of this runs.
const guest = { id: 'guest', displayName: 'Guest', verified: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function ask(messages: ChatMessage[] | Error, options: { actor?: typeof roee; channel?: string | null; request?: string } = {}) {
  const model = new Model();
  const m = new Meeting('m');
  const posts: string[] = [];
  const chat: ChatPort = { name: 'Slack', listChannels: async () => [],
    readChannel: async () => { if (messages instanceof Error) throw messages; return messages; },
    postMessage: async (_channel, text) => { posts.push(text); return { provider: 'slack', kind: 'message', label: 'c', url: 'u' }; } };
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])), agent: model, chat },
    { floor: { resumeAfterMs: 20, talkingMs: 20 }, retro: true, now: () => NOW,
      ...(options.channel === null ? {} : { recapChannel: options.channel ?? 'meeting-recaps' }) });
  await engine.startSession('s', m);
  await engine.onUtterance('s', { text: options.request ?? 'Nogita, prepare the retro.', eventId: '1', actor: options.actor ?? roee });
  await settle();
  return { model, m, posts, board };
}

test('"Nogita, prepare the retro": one model call on the recaps, in the chat and the channel; nothing opened', async () => {
  const f = await ask([recap('2026-11-05 09:00', 'Ship the board sync on Thursday')]);
  assert.equal(f.model.requests.length, 1);
  assert.equal(f.model.requests[0]!.tools.length, 0, 'no tools: it writes only from the data');
  assert.match(String(f.model.requests[0]!.messages[0]!.content), /Ship the board sync on Thursday/);
  assert.ok(f.m.chat.some(text => text.includes('Stuck: KAN-24')));
  assert.match(f.posts[0]!, /^Retro, last 14 days, from 1 meetings/);
  assert.match(f.m.spoken.join(' '), /The retro is in the chat, from 1 meeting\. One release shipped/);
  assert.equal(f.board.tasks.length, 0);
});

test('no recaps, an unreadable channel, no channel, or a guest: no retro and no model call, and she says why', async () => {
  const cases: Array<[Awaited<ReturnType<typeof ask>>, RegExp]> = [
    [await ask([]), /no meeting recaps from the last 14 days/],
    [await ask([recap('2026-01-01 09:00', 'Old')]), /no meeting recaps/],
    [await ask(new Error('missing_scope')), /could not read meeting-recaps/],
    [await ask([], { channel: null }), /no recap channel/],
    [await ask([recap('2026-11-05 09:00', 'x')], { actor: guest }), /Only the team/],
  ];
  for (const [f, said] of cases) {
    assert.equal(f.model.requests.length, 0);
    assert.match(`${f.m.spoken.join(' ')} ${f.m.chat.join(' ')}`, said);
    assert.equal(f.posts.length, 0);
  }
});
