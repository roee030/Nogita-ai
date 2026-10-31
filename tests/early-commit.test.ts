import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeCommandRouter, isCommitReady } from '../src/app/attendee-command-router.ts';
import type { Utterance } from '../src/core/contracts.ts';
import type { EmitContext } from '../src/app/attendee-command-router.ts';

function rig(earlyCommitMs = 300) {
  const emitted: Array<{ utterance: Utterance; context: EmitContext }> = [];
  const cancelled: string[] = [];
  const jobs = new Map<object, { work: () => void | Promise<void>; ms: number }>();
  const router = new AttendeeCommandRouter(async (_s, utterance, context) => { emitted.push({ utterance, context }); }, async () => {}, {
    chatAck: false, earlyCommitMs,
    schedule: (work, ms) => { const key = {}; jobs.set(key, { work, ms }); return key; }, cancel: key => { jobs.delete(key as object); },
    speculate: (_s, u) => ({ cancel() { cancelled.push(u.text); } }),
  });
  router.beginSession('s');
  const request = (text: string, id: string, turn = 't1') => ({ sessionId: 's', botId: 'bot_test', speakerUuid: 'p',
    utterance: { eventId: id, inputTurnIds: [turn], text, actor: { id: 'a', displayName: 'A', verified: true } } });
  /** Runs the scheduled jobs of exactly `ms` (the commit timer), as if that much quiet passed. */
  const elapse = async (ms: number) => {
    for (const [key, job] of [...jobs]) if (job.ms === ms) { jobs.delete(key); await job.work(); }
  };
  return { router, request, emitted, cancelled, jobs, elapse };
}

test('commit-ready: a complete sentence addressed to her, nothing dangling', () => {
  for (const text of ['Nogita, which file has the main meeting entry.', 'Nogita, which Jira project do you create tasks in?',
    'Nogita, walk me through how a spoken question flows through the code step by step.', 'Nogita. How many open tasks?'])
    assert.equal(isCommitReady(text), true, text);
  // Measured: every early transcript the speaker went on from lacked closing punctuation or was only her name.
  for (const text of ['Nogita.', 'Nogita, which Jira project do you create task', 'Nogita, what about the',
    'Nogita, which file has the meeting engine', 'Nogita, can you check?', 'Nogita, what about the?', 'Should we ship it?',
    'Nogita, is it in the?'])
    assert.equal(isCommitReady(text), false, text);
});

test('a complete question commits after a short own-voice silence instead of waiting for the confirmed end of turn', async () => {
  const f = rig();
  f.router.acceptEagerTurn(f.request('Nogita, which file has the main meeting entry.', 'e1'));
  assert.equal(f.emitted.length, 0);
  await f.elapse(300);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]!.utterance.text, 'Nogita, which file has the main meeting entry.');
  assert.ok(f.emitted[0]!.context.speculation, 'the early start is adopted, not restarted');
  // Flux confirms the same words later: nothing new.
  await f.router.acceptCompletedTurn(f.request('Nogita, which file has the main meeting entry.', 'f1'));
  assert.equal(f.emitted.length, 1);
  assert.deepEqual(f.cancelled, []);
});

test('own voice before the commit window ends keeps waiting for the confirmed turn', async () => {
  const f = rig();
  f.router.acceptEagerTurn(f.request('Nogita, which file has the main meeting entry.', 'e1'));
  f.router.noteOwnVoice('s', 'p');
  await f.elapse(300);
  assert.equal(f.emitted.length, 0);
  await f.router.acceptCompletedTurn(f.request('Nogita, which file has the main meeting entry.', 'f1'));
  assert.equal(f.emitted.length, 1);
});

test('TurnResumed cancels a pending commit', async () => {
  const f = rig();
  f.router.acceptEagerTurn(f.request('Nogita, which Jira project do you create tasks in?', 'e1'));
  f.router.resumeTurn('s', 'p');
  await f.elapse(300);
  assert.equal(f.emitted.length, 0);
});

test('when the speaker adds words after a commit, only the new words go on (the engine answers the whole question)', async () => {
  const f = rig();
  f.router.acceptEagerTurn(f.request('Nogita, which file starts the server?', 'e1'));
  await f.elapse(300);
  await f.router.acceptCompletedTurn(f.request('Nogita, which file starts the server? The production one.', 'f1'));
  assert.deepEqual(f.emitted.map(item => item.utterance.text), ['Nogita, which file starts the server?', 'The production one.']);
});

test('a confirmed turn for a different input turn is never swallowed', async () => {
  const f = rig();
  f.router.acceptEagerTurn(f.request('Nogita, what does 429 mean?', 'e1', 't1'));
  await f.elapse(300);
  await f.router.acceptCompletedTurn(f.request('Nogita, what does 429 mean?', 'f2', 't2'));
  assert.equal(f.emitted.length, 2);
});

test('off by default: no commit timer, the confirmed turn decides', async () => {
  const f = rig(0);
  f.router.acceptEagerTurn(f.request('Nogita, which file has the main meeting entry.', 'e1'));
  assert.equal(f.jobs.size, 0);
  await f.router.acceptCompletedTurn(f.request('Nogita, which file has the main meeting entry.', 'f1'));
  assert.equal(f.emitted.length, 1);
});
