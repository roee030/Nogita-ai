import test from 'node:test';
import assert from 'node:assert/strict';
import { findVolunteer, meetingQuotes, withMeetingQuotes } from '../src/core/drafting.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoCode } from '../src/adapters/demo.ts';
import { MemoryBoard } from '../src/adapters/memory.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };

test('quotes keep what people said before the request, not what was said to or by Nogita', () => {
  const quotes = meetingQuotes([
    'Dana Katz: the checkout page times out after thirty seconds on mobile',
    'Nogita: Sounds like the payment call.',
    'Avi Levi: Nogita, what is the timeout today?',
    'Avi Levi: ok',
    'Avi Levi: it only happens with the new card form',
  ]);
  assert.deepEqual(quotes, [
    { speaker: 'Dana Katz', text: 'the checkout page times out after thirty seconds on mobile' },
    { speaker: 'Avi Levi', text: 'it only happens with the new card form' },
  ]);
  const described = withMeetingQuotes('Fix the checkout timeout.', ['Dana Katz: the checkout page times out on mobile']);
  assert.match(described, /^Fix the checkout timeout\.\n\nSaid in the meeting just before the request:\n- Dana Katz: the checkout page times out on mobile$/);
  assert.equal(withMeetingQuotes('Plain.', []), 'Plain.');
  assert.ok(withMeetingQuotes('x'.repeat(5000), ['Dana: one two three four']).length <= 4000);
});

test('a volunteer is someone who took it on out loud, the newest claim wins', () => {
  assert.equal(findVolunteer(['Dana Katz: the export is broken again', "Avi Levi: I'll take it"]), 'Avi Levi');
  assert.equal(findVolunteer(['Avi Levi: Dana can handle the export', 'Lead: sounds good']), 'Dana');
  assert.equal(findVolunteer(["Avi Levi: I'll take it", "Dana Katz: actually I've got this"]), 'Dana Katz');
  assert.equal(findVolunteer(['Avi Levi: I can see the error in the logs']), undefined);
  assert.equal(findVolunteer(["Nogita: I'll take a look."]), undefined);
  assert.equal(findVolunteer(['Avi Levi: Nogita, can you handle it?']), undefined);
  assert.equal(findVolunteer(["Avi Levi: I'll take it", 'a', 'b', 'c', 'd', 'e', 'f']), undefined, 'too long ago');
});

test('a new task quotes the meeting and goes to the person who said they would take it', async () => {
  const board = new MemoryBoard('memory', 'MEM', new Map([['lead', 'Lead Person'], ['avi', 'Avi Levi']]));
  const people = new IdentityDirectory([{ id: 'lead', displayName: 'Lead Person' }, { id: 'avi', displayName: 'Avi Levi' }]);
  const lines = ['Dana Katz: the invoice export drops the last row every time', "Avi Levi: I'll take it"];
  const toolbox = buildToolbox({ actor: lead, request: 'open a ticket for that', sessionId: 's', eventId: 'e', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new Map(), transcript: () => lines,
    onReceipt: async () => undefined }).toolbox;
  const result = await toolbox.run('create_task', { title: 'Invoice export drops the last row', description: 'The export misses its final row.' });
  assert.match(result.content, /assigned to Avi Levi, who said they would take it/);
  assert.equal(board.tasks[0]!.assigneeId, 'avi');
  assert.match(board.tasks[0]!.description, /- Dana Katz: the invoice export drops the last row every time/);

  // A named owner wins over the volunteer; a volunteer the board does not know leaves the task unassigned.
  const other = buildToolbox({ actor: lead, request: 'open a ticket for that', sessionId: 's', eventId: 'e2', people,
    policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board, completed: new Map(),
    transcript: () => ['Dana Katz: the logo is blurry on retina screens', "Dana Katz: I'll take it"], onReceipt: async () => undefined }).toolbox;
  const unassigned = await other.run('create_task', { title: 'Blurry logo', description: 'Retina.' });
  assert.match(unassigned.content, /unassigned/);
});
