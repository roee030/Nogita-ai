/**
 * P9-24: from the Meet test on 11 Nov (smoke-2026-11-11c). With NOGITA_LISTEN_FIRST on, Roee asked three times to have it
 * explained aloud ("I want you to explain it, don't send in the chat") and got one sentence and "more in the chat" each
 * time. NOGITA_SPEAK_WHEN_ASKED (off) lets an explicit request get the full answer aloud. When she speaks is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine, REST_IN_CHAT, asksToExplain, refusesChat } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { speakWhenAsked } from '../src/app/config.ts';

// Over 25 words (listen-first's spoken limit), under 120 (the detail limit).
const LONG = 'Four pull requests merged in the last three days. The first adds meeting types in shadow mode. ' +
  'The second records your label decisions. The third adds the screen notes from Attendee. The fourth keeps the first speaker from being treated as alone.';

class Scripted implements ChatModel {
  readonly agentModel = 'scripted';
  calls = 0;
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.calls++;
    onText(LONG);
    return { content: [{ type: 'text', text: LONG }] as AgentContent[], stopReason: 'end_turn' };
  }
}
class Recording extends DemoMeeting {
  readonly spoken: string[] = [];
  override async speak(message: string): Promise<void> { this.spoken.push(message); await super.speak(message); }
  override async sendStatus(_message: string): Promise<void> { /* chat copy */ }
}
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };
const dana = { id: 'dana', displayName: 'Dana Levi', verified: true };

async function meeting(speakWhenAsked: boolean) {
  const model = new Scripted();
  const m = new Recording('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee', 'dana'])), agent: model,
    people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }, { id: 'dana', displayName: 'Dana Levi' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, listenFirst: true, speakWhenAsked });
  await engine.startSession('s', m);
  let n = 0;
  const say = async (text: string, actor = roee) => {
    const before = m.spoken.length;
    await engine.onUtterance('s', { text, eventId: String(++n), actor });
    await new Promise(resolve => setTimeout(resolve, 30));
    return m.spoken.slice(before).join(' ');
  };
  return { model, m, say };
}
const restInChat = (spoken: string) => REST_IN_CHAT.some(phrase => spoken.includes(phrase));

test('P9-24: the requests from 11 Nov are recognized, and an ordinary question is not', () => {
  assert.ok(refusesChat("Nogita, I want you to explain it, don't send in the chat."));
  assert.ok(refusesChat('תסבירי, אל תשלחי בצאט'));
  assert.ok(asksToExplain('Nogita, can you explain me what you send in the chat? Do a summarize.'));
  assert.ok(asksToExplain('Please explain me nogita.'));
  assert.ok(!refusesChat('Nogita, what did we merge in the last three days?'));
  assert.ok(!asksToExplain('Nogita, what did we merge in the last three days?'));
});

test('P9-24: flag off, listen-first stays one sentence even when asked, as on 11 Nov', async () => {
  const f = await meeting(false);
  const spoken = await f.say("Nogita, I want you to explain it, don't send in the chat.");
  assert.ok(restInChat(spoken), spoken);
});

test('P9-24: flag on, "explain it, don\'t send in the chat" gets the whole answer aloud, and that holds for the person', async () => {
  const f = await meeting(true);
  const first = await f.say('Nogita, what did we merge in the last three days?');
  assert.ok(restInChat(first), 'an ordinary question is still one sentence');
  const asked = await f.say("Nogita, I want you to explain it, don't send in the chat.");
  assert.ok(asked.includes('The fourth keeps the first speaker'), asked);
  assert.ok(!restInChat(asked));
  const later = await f.say('Nogita, what did we merge in the last three days?');
  assert.ok(!restInChat(later), '"not in the chat" holds for the rest of the meeting');
  // Someone else who never asked still gets listen-first.
  const other = await f.say('Nogita, what did we merge in the last three days?', dana);
  assert.ok(restInChat(other), other);
});

test('P9-24: "explain" alone is this turn only', async () => {
  const f = await meeting(true);
  assert.ok(!restInChat(await f.say('Nogita, please explain what we merged.')));
  assert.ok(restInChat(await f.say('Nogita, what did we merge in the last three days?')));
});

test('P9-24: the flag reads true or false, off by default', () => {
  assert.equal(speakWhenAsked({}), false);
  assert.equal(speakWhenAsked({ NOGITA_SPEAK_WHEN_ASKED: 'true' }), true);
  assert.throws(() => speakWhenAsked({ NOGITA_SPEAK_WHEN_ASKED: 'yes' }));
});
