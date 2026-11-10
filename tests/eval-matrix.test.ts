import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MATRIX_CASES, type MeetingCase } from '../tools/eval-matrix/cases.ts';
import { scoreCase, renderScore, wordErrors, type SystemOutput } from '../tools/eval-matrix/score.ts';
import { agreement, cohensKappa, renderAgreement } from '../tools/eval-matrix/agreement.ts';
import { buildCoverage, renderCoverage } from '../tools/eval-matrix/coverage.ts';
import { renderReview } from '../tools/eval-matrix/review.ts';

const daily = MATRIX_CASES.find(c => c.id === 'daily-drift-he')!;
const approveOne = MATRIX_CASES.find(c => c.id === 'approve-one-of-three')!;

/** What a perfect system would produce for a case. */
function perfect(meeting: MeetingCase): SystemOutput {
  const by = <T>(pick: (u: MeetingCase['utterances'][number]) => T) => Object.fromEntries(meeting.utterances.map(u => [u.id, pick(u)]));
  return { transcript: by(u => u.text), speakers: by(u => u.speaker), overlaps: meeting.utterances.filter(u => u.overlaps).map(u => u.id),
    topics: by(u => u.topic), kinds: by(u => u.kind),
    actions: meeting.actions.map((a, i) => ({ matches: i + 1, owner: a.owner, due: a.due })), writes: [...meeting.approval.approvedInMeeting] };
}

test('P9-15: every matrix case is consistent and readable', () => {
  assert.equal(new Set(MATRIX_CASES.map(c => c.id)).size, MATRIX_CASES.length);
  for (const meeting of MATRIX_CASES) {
    const ids = new Set(meeting.utterances.map(u => u.id));
    const topics = new Set(meeting.topics.map(t => t.id));
    assert.equal(ids.size, meeting.utterances.length, meeting.id);
    for (const u of meeting.utterances) {
      assert.ok(u.end > u.start, `${u.id} has a positive span`);
      assert.ok(meeting.speakers[u.speaker], `${u.id} speaker is listed`);
      assert.ok(topics.has(u.topic), `${u.id} topic exists`);
      for (const term of u.terms ?? []) assert.ok(u.text.toLowerCase().includes(term.toLowerCase()), `${u.id} contains "${term}"`);
      for (const other of u.overlaps ?? []) {
        const o = meeting.utterances.find(x => x.id === other);
        assert.ok(o && o.speaker !== u.speaker && o.start < u.end && u.start < o.end, `${u.id} really overlaps ${other}`);
      }
    }
    for (const a of meeting.actions) {
      assert.ok(topics.has(a.topic));
      for (const source of a.source) assert.ok(ids.has(source), `${meeting.id}: source ${source}`);
      if (a.tentativeOwner) assert.equal(a.owner, null, 'a tentative owner is never also the confirmed owner');
    }
    for (const n of meeting.approval.approvedInMeeting) assert.ok(n >= 1 && n <= meeting.actions.length);
    for (const link of meeting.links) assert.ok(topics.has(link.from) && topics.has(link.to));
  }
});

test('P9-15: the daily covers what the work plan asks for', () => {
  assert.equal(Object.keys(daily.speakers).length, 4);
  assert.ok(Object.values(daily.speakers).every(s => !s?.verifiedName), 'no names are inferred');
  assert.ok(daily.utterances.some(u => /[֐-׿]/.test(u.text) && u.terms?.length), 'Hebrew with English terms');
  assert.ok(daily.utterances.filter(u => u.overlaps).length >= 2, 'cross-talk');
  assert.ok(daily.utterances.filter(u => u.kind === 'backchannel').length >= 4, 'short acknowledgements');
  assert.ok(new Set(daily.utterances.map(u => u.topic)).size >= 4, 'drifts across topics');
  assert.ok(daily.actions.some(a => a.owner === null && a.tentativeOwner), '"I will look into it" is not an owner');
  assert.ok(daily.actions.some(a => a.owner === null && !a.tentativeOwner), 'a blocker nobody took');
  assert.ok(daily.utterances.some(u => /Plan Agent/.test(u.text)), 'a Plan Agent suggestion');
  assert.deepEqual(daily.approval.approvedInMeeting, [], 'nothing approved, nothing written');
  assert.ok(daily.links.every(l => l.strength === 'uncertain'), 'the only link is marked uncertain');
});

test('P9-15: a perfect output scores right on every layer and blocks nothing', () => {
  for (const meeting of MATRIX_CASES) {
    for (const result of scoreCase(meeting, perfect(meeting))) {
      assert.ok(result.scored, `${meeting.id} layer ${result.layer}`);
      assert.deepEqual(result.problems, [], `${meeting.id} layer ${result.layer}`);
      assert.ok(!result.blocking);
      for (const [name, c] of Object.entries(result.counts)) assert.equal(c.right, c.of, `${meeting.id} ${result.layer} ${name}`);
    }
  }
});

test('P9-15: layers fail separately: a lost term, a wrong voice, an invented owner, an unapproved write', () => {
  const output = perfect(daily);
  output.transcript!.u05 = 'הייתי הולך על רדיס עם טי טי אל של שלושים שניות';
  output.speakers!.u06 = 'S3';
  output.speakers!.u13 = 'unknown';
  output.kinds!.u09 = 'decision';
  output.actions![1] = { matches: 2, owner: 'S2', due: 'tomorrow' };
  output.writes = [2];
  const results = scoreCase(daily, output);
  const layer = (n: number) => results.find(r => r.layer === n)!;
  assert.deepEqual(layer(1).problems, ['u05: lost the term "Redis"', 'u05: lost the term "TTL"']);
  assert.deepEqual(layer(2).problems, ['u06: said by S4, attributed to S3']);
  assert.equal(layer(2).counts.notWrongVoice!.right, layer(2).counts.notWrongVoice!.of - 1, '"unknown" is not a wrong voice');
  assert.deepEqual(layer(3).problems, []);
  assert.equal(layer(4).counts.notAFalseDecision!.right, layer(4).counts.notAFalseDecision!.of - 1);
  assert.equal(layer(5).counts.leftUnknownOpen!.right, layer(5).counts.leftUnknownOpen!.of - 1);
  assert.equal(layer(6).blocking, true);
  assert.match(renderScore(daily, results), /wrote action 2 without approval[\s\S]*/);
  assert.match(renderScore(daily, results), /write authorization: .* \*\*BLOCKS\*\*/);
});

test('P9-15: approving one item writes exactly that one; missing it is reported, a layer with no output is not scored', () => {
  assert.equal(scoreCase(approveOne, { writes: [1] }).find(r => r.layer === 6)!.blocking, false);
  const none = scoreCase(approveOne, { writes: [] }).find(r => r.layer === 6)!;
  assert.deepEqual(none.problems, ['approved action 1 was not written']);
  assert.equal(scoreCase(approveOne, { writes: [1, 3] }).find(r => r.layer === 6)!.blocking, true);
  assert.equal(scoreCase(approveOne, {}).find(r => r.layer === 1)!.scored, false);
  assert.match(renderScore(approveOne, scoreCase(approveOne, {})), /1\. transcription: not scored/);
});

test('P9-15: word errors count edits over reference words', () => {
  assert.deepEqual(wordErrors('a b c d', 'a b c d'), { right: 4, of: 4 });
  assert.deepEqual(wordErrors('a b c d', 'a x c'), { right: 2, of: 4 });
});

test('P9-15: judge vs human: exact agreement, kappa and within one, with counts', () => {
  assert.equal(cohensKappa([['a', 'a'], ['b', 'b']]), 1);
  // Observed 0.5, chance 0.5: no agreement beyond chance.
  assert.equal(cohensKappa([['pass', 'pass'], ['pass', 'fail'], ['fail', 'pass'], ['fail', 'fail']]), 0);
  assert.equal(cohensKappa([['a', 'a']]), undefined);
  const results = agreement([
    { caseId: 'c1', dimension: 'recap', judge: 4, human: 4 }, { caseId: 'c2', dimension: 'recap', judge: 5, human: 3 },
    { caseId: 'c1', dimension: 'owner', judge: 'pass', human: 'fail' }]);
  assert.deepEqual(results.map(r => [r.dimension, r.n, r.exact, r.withinOne]), [['owner', 1, 0, undefined], ['recap', 2, 1, 1]]);
  const text = renderAgreement(results);
  assert.match(text, /\| recap \| 1\/2 \|/);
  assert.match(text, /owner \/ c1: judge pass, human fail/);
  assert.match(text, /Diagnostic only: no agreement level is a gate/);
});

test('P9-15: the coverage report names its blocked rows and the committed docs are up to date', () => {
  const rows = buildCoverage();
  const blocked = rows.filter(r => r.status === 'blocked').map(r => r.note ?? '');
  assert.ok(blocked.some(n => /P8-13/.test(n)) && blocked.some(n => /P9-9/.test(n)) && blocked.some(n => /P9-18/.test(n)));
  assert.ok(rows.find(r => r.value === 'Hebrew audio through the voice path')!.status === 'gap');
  const coverage = readFileSync(new URL('../docs/EVAL_COVERAGE.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(coverage.includes(renderCoverage(rows)), 'run npm run eval-matrix -- coverage');
  const review = readFileSync(new URL('../docs/EVAL_MATRIX_REVIEW.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(review.includes(renderReview(MATRIX_CASES)), 'run npm run eval-matrix -- review');
});
