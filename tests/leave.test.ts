import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy, directlyAddressesNogita, isExplicitLeaveRequest, removeAddress } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import type { Capability } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const leaves = (text: string) => directlyAddressesNogita(text) && isExplicitLeaveRequest(removeAddress(text));

test('leave: the ways people actually send her away', () => {
  for (const text of ['Nogita, you can leave now, thanks.', 'Nogita, leave the meeting, thank you.', 'Okay Nogita, you can go.',
    'Nogita, you can go now.', 'Nogita, bye.', 'Nogita, goodbye everyone.', 'Nogita, we are done, you can leave.',
    'Nogita, get out of the meeting.', 'Nogita, I need you to leave the meeting.', 'Nogita, time to go.',
    'Nogita, thanks, that is all, you can leave.', 'Nogita, you may leave.', 'Nogita, you can hang up.', 'Nogita, sign off.',
    'Nogita, thank you, bye bye.', 'Nogita, that’s it, you can drop off.', 'Nogita, could you please leave the meeting?']) {
    assert.equal(leaves(text), true, text);
  }
});

test('leave: not a goodbye', () => {
  for (const text of ["Nogita, don't leave yet.", 'Nogita, go ahead.', 'Nogita, time to go to the next item.',
    'Nogita, what time do you leave?', 'Nogita, leave a comment on KAN-20.', 'Nogita, we are done with the API.',
    'Nogita, thanks.', 'Nogita, go through the list.', 'Nogita, hang on.', 'Nogita, bye?', 'Nogita, leave this meeting?',
    'Nogita, should we drop this meeting from the calendar?']) {
    assert.equal(leaves(text), false, text);
  }
});

test('leave: an unverified speaker can still send her away, and nothing reaches the model', async () => {
  const left: string[] = []; const emitted: string[] = []; const statuses: string[] = [];
  const jobs: Array<() => void | Promise<void>> = [];
  const router = new AttendeeCommandRouter(async (_s, u) => { emitted.push(u.text); }, async (_s, m) => { statuses.push(m); },
    { randomCode: () => '482731', onLeave: async sessionId => { left.push(sessionId); },
      schedule: work => { jobs.push(work); return jobs.length; }, cancel: () => undefined });
  router.beginSession('s', lead);
  const guest = { id: 'unmapped:guest', displayName: 'Guest', verified: false };
  void router.accept({ sessionId: 's', botId: 'bot', speakerUuid: 'guest-mic', utterance: { eventId: 'g1', actor: guest, text: 'Nogita, you can go now, thanks.' } });
  while (jobs.length) await jobs.shift()!();
  assert.deepEqual(left, ['s']);
  assert.deepEqual(emitted, []);
  assert.ok(!statuses.some(status => /cannot verify/i.test(status)));
});

/** Answers once with a goodbye and a leave_meeting call, then ends. */
class GoodbyeModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(structuredClone(request));
    if (this.requests.length > 1) return { content: [], stopReason: 'end_turn' };
    onText('Sure, bye everyone.');
    const content: AgentContent[] = [{ type: 'text', text: 'Sure, bye everyone.' },
      { type: 'tool_use', id: 'leave-1', name: 'leave_meeting', input: {} }];
    return { content, stopReason: 'tool_use' };
  }
}

function engineWith(model: ChatModel, meeting: DemoMeeting, requested: string[]) {
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, floor: { resumeAfterMs: 20, talkingMs: 20 },
    onLeaveRequested: sessionId => { requested.push(sessionId); } });
  return engine;
}

test('leave: words the fast check misses reach the model, which says goodbye and then she leaves', async () => {
  const model = new GoodbyeModel(); const meeting = new DemoMeeting('m'); const requested: string[] = [];
  const engine = engineWith(model, meeting, requested);
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, alright, I think we are done here, you can head off.', eventId: '1', actor: lead });
  assert.ok(model.requests[0]!.tools.some(tool => tool.name === 'leave_meeting'));
  assert.ok(meeting.events.some(event => event.type === 'speak' && /bye everyone/i.test(event.text ?? '')));
  assert.deepEqual(requested, ['s']);
});

test('leave: the model cannot leave when nobody asked', async () => {
  const model = new GoodbyeModel(); const meeting = new DemoMeeting('m'); const requested: string[] = [];
  const engine = engineWith(model, meeting, requested);
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, what is in the README?', eventId: '1', actor: lead });
  assert.deepEqual(requested, []);
});

class TextThread extends DemoMeeting {
  override readonly capabilities: ReadonlySet<Capability> = new Set(['chat_receipt']);
}
test('leave: a text thread has no leave_meeting tool', async () => {
  const model = new GoodbyeModel(); const thread = new TextThread('t'); const requested: string[] = [];
  const engine = engineWith(model, thread, requested);
  await engine.startSession('s', thread);
  await engine.onUtterance('s', { text: 'Nogita, bye for now, you can go.', eventId: '1', actor: lead });
  assert.ok(!model.requests[0]?.tools.some(tool => tool.name === 'leave_meeting'));
  assert.deepEqual(requested, []);
});
