import test from 'node:test';
import assert from 'node:assert/strict';
import { corrections, gatePassed, interruptions, minutesSaved, scorecard, tableRow, type Segment } from '../tools/scorecard/score.ts';

const s = (speaker: string, start: number, end: number, text: string): Segment => ({ speaker, start: start * 1000, end: end * 1000, text, nogita: speaker === 'Nogita' });

test('the four kinds of interruption, from the 1 and 3 November Meets', () => {
  const found = interruptions([
    s('Roee', 0, 2.3, 'So, I\'m wondering?'), s('Roee', 2.9, 6.6, 'Push to to main branch.'),
    s('Nogita', 5.5, 7.5, 'Go ahead. What are you wondering?'),                                  // inside his turn
    s('Roee', 20, 25, 'To our board in jira about all the.'), s('Nogita', 25.1, 28, 'Sure, about what?'), // half-sentence
    s('Roee', 57, 59, 'Nogita, what can you do?'), s('Nogita', 60, 69, 'I can answer engineering questions and look things up for the team code.'),
    s('Roee', 63.8, 65.4, 'I told you wait a second stop.'),                                          // she went on
    s('Roee', 120, 123, 'Dana, are you coming tomorrow?'), s('Nogita', 124, 126, 'I can help with that.'), // not hers
  ]);
  assert.deepEqual(found.map(item => item.kind), ['talk_over', 'half_sentence', 'kept_talking', 'not_addressed']);
});

test('a clean exchange has no interruptions: named, finished, and a reply in a conversation', () => {
  assert.deepEqual(interruptions([
    s('Roee', 0, 2, 'Nogita, what landed today?'), s('Nogita', 3.5, 8, 'Sixteen pull requests merged.'),
    s('Roee', 10, 12, 'And which one is the biggest?'), s('Nogita', 13, 16, 'The board sync rewrite.'),
    s('Nogita', 30, 34, 'Here is the summary.'), s('Roee', 31, 31.4, 'mm-hm'),
  ]), []);
});

test('corrections: edits to what she wrote within a day, and deletions; workflow moves are not corrections', () => {
  const created = Date.parse('2026-11-01T15:14:00Z');
  assert.deepEqual(corrections([
    { key: 'KAN-24', created, changes: [{ at: created + 3_600_000, field: 'status' }] },
    { key: 'KAN-25', created, changes: [{ at: created + 600_000, field: 'summary' }, { at: created + 700_000, field: 'description' }] },
    { key: 'KAN-26', created, deleted: true, changes: [] },
    { key: 'KAN-27', created, changes: [{ at: created + 3 * 86_400_000, field: 'summary' }] },
  ]), [{ key: 'KAN-25', why: 'summary, description changed' }, { key: 'KAN-26', why: 'deleted' }]);
});

test('minutes saved from the chat, in English or Hebrew', () => {
  assert.equal(minutesSaved(['saved 15', 'thanks']), 15);
  assert.equal(minutesSaved(['this saved me about 20 minutes']), 20);
  assert.equal(minutesSaved(['חסכה לי 12 דקות']), 12);
  assert.equal(minutesSaved(['great meeting']), undefined);
});

test('pass needs all three targets; unknown minutes is undecided; the gate is five passes in a row', () => {
  const clean = [s('Roee', 0, 2, 'Nogita, summarize the decisions.'), s('Nogita', 3, 8, 'Two decisions, posted in the chat.')];
  assert.equal(scorecard({ session: 'm', date: '2026-11-04', segments: clean, tasks: [], chat: ['saved 15'] }).pass, true);
  assert.equal(scorecard({ session: 'm', date: '2026-11-04', segments: clean, tasks: [], chat: ['saved 5'] }).pass, false);
  assert.equal(scorecard({ session: 'm', date: '2026-11-04', segments: clean, tasks: [], chat: [] }).pass, null);
  const row = (result: boolean) => tableRow(scorecard({ session: 'm', date: '2026-11-04', segments: clean, tasks: [], chat: [result ? 'saved 15' : 'saved 1'] }), 'f.md');
  assert.equal(gatePassed([row(true), row(true), row(true), row(true)]), false);
  assert.equal(gatePassed([row(false), row(true), row(true), row(true), row(true), row(true)]), true);
  assert.equal(gatePassed([row(true), row(true), row(true), row(true), row(false)]), false);
});
