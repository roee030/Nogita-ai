/**
 * P9-15 (partial): a meeting chat that accepts every message and shows none of them, as Roee saw on 1 November
 * (send_chat_message returned success; nothing appeared). This pins down today's behavior offline, so P8-12 can say
 * which part of it is real. It changes nothing: where she believes a message arrived, the test says so as a known gap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import type { ChatMessage, ChatPort } from '../src/core/contracts.ts';

const RECAP = JSON.stringify({ decisions: ['Ship the board sync on Thursday'], actionItems: [], openQuestions: [],
  proposedTasks: [{ title: 'Ship the board sync', description: 'Decided today' }] });
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

class Model implements ChatModel {
  readonly agentModel = 'scripted';
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const text = request.stableSystem.startsWith('You write the recap') ? RECAP : 'Sure.';
    onText(text);
    return { content: [{ type: 'text', text }] as AgentContent[], stopReason: 'end_turn' };
  }
}

/** Every chat send "succeeds"; nobody in the meeting sees any of it. `attempted` is what she believes she posted. */
class SilentChatMeeting extends DemoMeeting {
  readonly attempted: string[] = [];
  override async sendStatus(message: string): Promise<void> { this.attempted.push(message); }
  spoken(): string[] { return this.events.flatMap(event => event.type === 'speak' ? [event.text ?? ''] : []); }
}

function slack() {
  const messages: ChatMessage[] = [];
  const chat: ChatPort = { name: 'Slack', listChannels: async () => [], readChannel: async () => messages, searchMessages: async () => messages,
    postMessage: async (channel, text) => {
      messages.push({ channel, author: 'Nogita', at: '2026-11-10 10:00', text });
      return { provider: 'slack', kind: 'message', label: channel, url: 'https://slack.example/1' };
    } };
  return { chat, messages };
}

function engine(options: { recapChannel?: string; chat?: ChatPort } = {}) {
  return new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(), policy: new AllowlistPolicy(new Set(['roee'])),
    agent: new Model(), ...(options.chat ? { chat: options.chat } : {}) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, meetingRecap: true,
    ...(options.recapChannel ? { recapChannel: options.recapChannel } : {}) });
}

let events = 0;
async function meetingWith(nogita: NogitaEngine, id: string, lines: string[]) {
  const meeting = new SilentChatMeeting(id);
  await nogita.startSession(id, meeting);
  for (const text of lines) await nogita.onUtterance(id, { text, eventId: String(++events), actor: roee });
  await settle();
  return meeting;
}

test('silent chat: with a recap channel, the final recap still reaches people', async () => {
  const { chat, messages } = slack();
  const nogita = engine({ recapChannel: 'meeting-recaps', chat });
  const meeting = await meetingWith(nogita, 'a', ['We decided to ship the board sync on Thursday.', 'Nogita, what is next?']);
  await nogita.endSession('a', false);
  await settle();
  assert.ok(meeting.attempted.length > 0, 'she posted to the meeting chat, which nobody sees');
  assert.equal(messages.length, 1, 'the channel copy is the one that arrives');
  assert.match(messages[0]!.text, /Ship the board sync/);
});

test('silent chat, known gap: a recap asked for during the meeting is announced as "in the chat", and nobody sees it', async () => {
  const meeting = await meetingWith(engine(), 'b', ['We decided to ship the board sync on Thursday.', 'Nogita, summarize']);
  await settle();
  assert.ok(meeting.attempted.some(text => /Ship the board sync/.test(text)), 'she posted it, as far as she knows');
  assert.ok(meeting.spoken().some(text => /recap is in the chat/i.test(text)), 'and said so aloud');
  // Gap: that was the only copy, and she cannot know it was lost (Attendee reports no failure).
});

test('silent chat, known gap: without a recap channel the final recap is lost and nothing says so', async () => {
  const nogita = engine();
  const meeting = await meetingWith(nogita, 'c', ['We decided to ship the board sync on Thursday.', 'Nogita, what is next?']);
  await nogita.endSession('c');
  await settle();
  assert.ok(meeting.attempted.some(text => /Meeting recap/.test(text)), 'the final recap went only to the meeting chat');
  // Gap: the meeting chat was the only copy, and nothing reports the loss.
});
