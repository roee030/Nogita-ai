import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionItemTracker, actionItemIn } from '../src/core/drafting.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const dana = { id: 'dana', displayName: 'Dana Katz', verified: true };

test('action items: "we need to", "someone should" and "I\'ll update" are items; questions and talk to Nogita are not', () => {
  assert.deepEqual(actionItemIn('Dana', 'we need to rotate the staging keys before Friday.'), { speaker: 'Dana', text: 'rotate the staging keys before Friday' });
  assert.deepEqual(actionItemIn('Avi', "someone should check why the export is slow"), { speaker: 'Avi', text: 'check why the export is slow' });
  assert.deepEqual(actionItemIn('Avi', "I'll update the onboarding docs"), { speaker: 'Avi', text: 'update the onboarding docs', owner: 'Avi' });
  assert.equal(actionItemIn('Avi', 'do we need to rotate the keys?'), undefined);
  assert.equal(actionItemIn('Avi', 'Nogita, we need to open a task for the keys'), undefined);
  assert.equal(actionItemIn('Nogita', 'We should check that.'), undefined);
  assert.equal(actionItemIn('Avi', 'the build looks fine today'), undefined);
});

test('a claim or a task within a few lines gives the newest open item its owner', () => {
  const items = new ActionItemTracker();
  items.hear('Dana Katz', 'we need to rotate the staging keys');
  items.hear('Avi Levi', "I'll take it");
  items.hear('Dana Katz', 'someone should look at the flaky login test');
  items.hear('Lead', 'and we have to update the status page copy');
  items.taskCreated('KAN-9');
  items.hear('Avi Levi', "I'll look into it");
  assert.deepEqual(items.list(), [
    { speaker: 'Dana Katz', text: 'rotate the staging keys', owner: 'Avi Levi' },
    { speaker: 'Dana Katz', text: 'look at the flaky login test', owner: 'Avi Levi' },
    { speaker: 'Lead', text: 'update the status page copy', owner: 'task KAN-9' },
  ]);
  const late = new ActionItemTracker();
  late.hear('Dana', 'we need to rotate the staging keys');
  for (const line of ['a', 'b', 'c', 'd']) late.hear('Avi', line);
  late.hear('Avi', "I'll take it");
  assert.deepEqual(late.unowned().map(item => item.text), ['rotate the staging keys']);
});

test('"what is still open?" lists the meeting items with their owners', async () => {
  const items = new ActionItemTracker();
  items.hear('Dana Katz', 'we need to rotate the staging keys');
  items.hear('Avi Levi', "I'll update the onboarding docs");
  const toolbox = buildToolbox({ actor: lead, request: "what's still open?", sessionId: 's', eventId: 'e',
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board: new DemoBoard(), completed: new Map(),
    actionItems: () => items.list(), onReceipt: async () => undefined }).toolbox;
  const result = await toolbox.run('meeting_action_items', {});
  assert.match(result.content, /rotate the staging keys \(raised by Dana Katz; NOBODY took it yet\)/);
  assert.match(result.content, /update the onboarding docs \(raised by Avi Levi; owner: Avi Levi\)/);
});

test('on leaving, the open items go to chat only when the recap is turned on, and are purged with the meeting', async () => {
  for (const recap of [true, false]) {
    const meeting = new DemoMeeting('m');
    const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
      policy: new AllowlistPolicy(new Set(['lead'])) }, { actionItemRecap: recap });
    await engine.startSession('s', meeting);
    await engine.onUtterance('s', { eventId: '1', actor: dana, text: 'we need to rotate the staging keys before Friday' });
    await engine.onUtterance('s', { eventId: '2', actor: lead, text: "I'll update the release notes" });
    await engine.endSession('s');
    const chat = meeting.events.filter(event => event.type === 'chat').map(event => event.text);
    if (recap) assert.deepEqual(chat, ['Open items nobody took: rotate the staging keys before Friday (Dana Katz).']);
    else assert.deepEqual(chat, []);
    assert.equal(meeting.events.at(-1)?.type, 'leave');
  }
});
