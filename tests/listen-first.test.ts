import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { IdentityDirectory } from '../src/core/identity.ts';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';

class Scripted implements ChatModel {
  readonly agentModel = 'scripted';
  calls = 0;
  constructor(private readonly replies: string[]) {}
  async streamChat(_request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    const text = this.replies[this.calls++] ?? 'Okay.';
    onText(text);
    return { content: [{ type: 'text', text }] as AgentContent[], stopReason: 'end_turn' };
  }
}
class Recording extends DemoMeeting {
  readonly spoken: string[] = [];
  readonly chat: string[] = [];
  override async speak(message: string): Promise<void> { this.spoken.push(message); await super.speak(message); }
  override async sendStatus(message: string): Promise<void> { this.chat.push(message); }
}
const roee = { id: 'roee', displayName: 'Roee Angel', verified: true };

async function meeting(listenFirst: boolean, replies: string[]) {
  const model = new Scripted(replies);
  const m = new Recording('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['roee'])), agent: model, people: new IdentityDirectory([{ id: 'roee', displayName: 'Roee Angel' }]) },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 }, listenFirst, swallowedQuestion: true });
  await engine.startSession('s', m);
  let n = 0;
  const say = (text: string) => engine.onUtterance('s', { text, eventId: String(++n), actor: roee });
  return { model, m, say };
}

test('one person in the call: an unnamed question gets an answer normally, silence in listen-first', async () => {
  const normal = await meeting(false, ['Sixteen PRs landed today.']);
  await normal.say('What landed in main today?');
  assert.equal(normal.model.calls, 1);
  const quiet = await meeting(true, ['Sixteen PRs landed today.']);
  assert.equal(await quiet.say('What landed in main today?'), 'ignored');
  assert.equal(quiet.model.calls, 0);
  assert.equal(quiet.m.spoken.length, 0);
});

test('listen-first: after her answer, unnamed talk is not hers; a reply to her own question is', async () => {
  const f = await meeting(true, ['Sixteen PRs landed today.', 'Which board should it go on?', 'Done, KAN-30.']);
  await f.say('Nogita, what landed today?');
  assert.equal(f.model.calls, 1);
  assert.equal(await f.say('And the one before that?'), 'ignored', 'a conversation reply without her name');
  assert.equal(f.model.calls, 1);
  await f.say('Nogita, open a task for the cache fix.');
  assert.equal(f.model.calls, 2);
  await f.say('The KAN board.');
  assert.equal(f.model.calls, 3, 'answering the question she asked');
});

test('listen-first: only her name, then silence: no "did you ask me something?"', async () => {
  const f = await meeting(true, []);
  assert.equal(await f.say('Nogita,'), 'ignored');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.m.spoken.length, 0);
  assert.equal(f.m.chat.length, 0);
  assert.equal(await f.say('Dana, can you take the release notes?'), 'ignored', 'named a moment ago, but these words are for Dana');
});

test('listen-first: one short sentence aloud, the whole answer in the chat', async () => {
  const long = 'Sixteen pull requests merged today. The biggest is the board sync rewrite, then the speech guard, the presence page, the scorecard, the write intent judge and a dozen smaller fixes across the engine, the audio hub and the voice lab.';
  const f = await meeting(true, [long]);
  await f.say('Nogita, what landed today?');
  const spokenWords = f.m.spoken.join(' ').split(/\s+/).filter(Boolean).length;
  assert.ok(spokenWords <= 25 + 6, `spoken ${spokenWords} words: ${f.m.spoken.join(' | ')}`);
  assert.ok(f.m.chat.some(text => text.includes('a dozen smaller fixes')), 'the full answer is in the chat');
});

test('listen-first: her name, then the question in the next words, is still hers', async () => {
  const f = await meeting(true, ['Sixteen PRs.']);
  assert.equal(await f.say('Nogita,'), 'ignored');
  await f.say('what landed today?');
  assert.equal(f.model.calls, 1);
});
