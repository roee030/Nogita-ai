import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionIn } from '../src/core/drafting.ts';
import { FileMeetingMemory } from '../src/app/meeting-memory.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import type { MeetingRecord } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const dana = { id: 'dana', displayName: 'Dana Katz', verified: true };

test('decisions are sentences that say a decision plainly', () => {
  assert.deepEqual(decisionIn('Dana', "Okay, we decided to ship the release on Monday."), { speaker: 'Dana', text: 'ship the release on Monday' });
  assert.deepEqual(decisionIn('Avi', "let's go with the queue for reminder emails"), { speaker: 'Avi', text: 'the queue for reminder emails' });
  assert.equal(decisionIn('Avi', 'did we decide on the release date?'), undefined);
  assert.equal(decisionIn('Avi', 'Nogita, we decided to open a task'), undefined);
  assert.equal(decisionIn('Avi', 'the release went fine'), undefined);
});

test('meeting memory keeps only decisions and items, finds them by topic, and forgets after the retention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogita-memory-'));
  try {
    let now = Date.parse('2026-10-01T10:00:00Z');
    const memory = new FileMeetingMemory(dir, 30, () => now);
    const release: MeetingRecord = { endedAt: '2026-10-01T10:00:00.000Z', decisions: [{ speaker: 'Dana', text: 'ship the release on Monday' }],
      actionItems: [{ speaker: 'Avi', text: 'update the changelog', owner: 'Avi' }] };
    await memory.remember(release);
    await memory.remember({ endedAt: '2026-10-01T10:00:00.000Z', decisions: [], actionItems: [] });
    assert.equal(readdirSync(join(dir, 'meetings')).length, 1, 'an empty meeting leaves nothing behind');
    assert.deepEqual(await memory.search('when is the release?'), [release]);
    assert.deepEqual(await memory.search('billing'), []);
    assert.equal((await memory.search('')).length, 1);

    now += 31 * 86_400_000;
    await memory.remember({ endedAt: '2026-11-01T10:00:00.000Z', decisions: [{ speaker: 'Lead', text: 'drop the cron job' }], actionItems: [] });
    assert.deepEqual((await memory.search('')).map(record => record.decisions[0]!.text), ['drop the cron job']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a meeting with memory on saves what it decided when it ends, and past_decisions answers later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogita-memory-'));
  try {
    const memory = new FileMeetingMemory(dir);
    const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
      policy: new AllowlistPolicy(new Set(['lead'])), memory });
    await engine.startSession('s', new DemoMeeting('m'));
    await engine.onUtterance('s', { eventId: '1', actor: dana, text: 'we agreed that the release moves to Monday' });
    await engine.onUtterance('s', { eventId: '2', actor: lead, text: 'someone should tell support about the new date' });
    await engine.endSession('s');
    const saved = readFileSync(join(dir, 'meetings', readdirSync(join(dir, 'meetings'))[0]!), 'utf8');
    assert.doesNotMatch(saved, /we agreed/, 'the sentence is kept, not the transcript line');

    const tools = (actorId: string) => buildToolbox({ actor: { ...lead, id: actorId }, request: 'what did we decide about the release?',
      sessionId: 's2', eventId: 'e', policy: new AllowlistPolicy(new Set(['lead'])), code: new DemoCode(), board: new DemoBoard(),
      completed: new Map(), memory, onReceipt: async () => undefined }).toolbox;
    const answer = await tools('lead').run('past_decisions', { topic: 'release' });
    assert.match(answer.content, /- decided: the release moves to Monday \(Dana Katz\)/);
    assert.match(answer.content, /- to do: tell support about the new date \(nobody took it\)/);
    assert.ok(!tools('guest').specs.some(spec => spec.name === 'past_decisions'), 'only people who may read project data');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
