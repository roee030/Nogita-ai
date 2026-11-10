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
  return { transcript: by(u => u.text), times: by(u => [u.start, u.end] as [number, number]), speakers: by(u => u.speaker),
    overlaps: meeting.utterances.filter(u => u.overlaps).map(u => u.id), topics: by(u => u.topic), kinds: by(u => u.kind),
    links: meeting.links.map(l => ({ from: l.from, to: l.to, strength: l.strength })),
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
  assert.equal(layer(2).counts.notAWrongVoice!.right, layer(2).counts.notAWrongVoice!.of - 1, '"unknown" is not a wrong voice');
  assert.equal(layer(2).counts.rightVoice!.right, layer(2).counts.rightVoice!.of - 2, '"unknown" is not the right voice either');
  assert.deepEqual(layer(3).problems, []);
  assert.deepEqual(layer(4).problems, ['u09: proposal, got decision', 'u09: a proposal read as a decision']);
  assert.equal(layer(4).counts.notAFalseDecision!.right, layer(4).counts.notAFalseDecision!.of - 1);
  assert.deepEqual(layer(5).problems, ['action 2: treated "S2 said maybe" as the owner', 'action 2: due not established, got tomorrow']);
  assert.equal(layer(5).counts.unknownsLeftUnknown!.right, layer(5).counts.unknownsLeftUnknown!.of - 1);
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

// Week of 10 Nov: audit fixes, more cases, voice-lab meeting types, review sheet.
import { MEETING_TYPE_SCENARIOS, SCENARIOS as LAB_SCENARIOS, type Turn } from '../tools/voice-lab/scenarios.ts';
import { scoreTurn } from '../tools/voice-lab/score.ts';
import type { TurnRecord } from '../tools/voice-lab/conversation.ts';
import { totals } from '../tools/eval-matrix/coverage.ts';

const byId = (id: string) => MATRIX_CASES.find(c => c.id === id)!;

test('P9-15: timestamps, links and an invented link are scored', () => {
  const retro = byId('retro-he');
  const output = perfect(retro);
  output.times!.r02 = [6, 9];
  output.links = [{ from: 'R1', to: 'R2', strength: 'uncertain' }, { from: 'R2', to: 'R9', strength: 'clear' }];
  const results = scoreCase(retro, output);
  assert.deepEqual(results.find(r => r.layer === 1)!.problems, ['r02: time 4.5–9, got 6–9']);
  assert.deepEqual(results.find(r => r.layer === 3)!.problems, ['link R1–R2: clear, got uncertain', 'link R2–R9 invented']);
  assert.deepEqual(results.find(r => r.layer === 3)!.counts.noInventedLink, { right: 1, of: 2 });
});

test('P9-15: a line labeled uncertain is not scored either way, and a guessed name is a problem', () => {
  const design = byId('design-review-he');
  const output = perfect(design);
  output.kinds!.d05 = 'proposal';
  output.speakers!.d02 = 'Dana';
  const results = scoreCase(design, output);
  assert.deepEqual(results.find(r => r.layer === 4)!.problems, []);
  assert.deepEqual(results.find(r => r.layer === 4)!.counts.uncertainNotScored, { right: 1, of: 1 });
  assert.ok(results.find(r => r.layer === 2)!.problems.includes('d02: named "Dana", which the call never verified'));
  // The verified name in the approval case is fine.
  const ok = scoreCase(approveOne, { speakers: { a01: 'S2', a02: 'S2', a03: 'S2', a04: 'Roee' } }).find(r => r.layer === 2)!;
  assert.deepEqual(ok.counts.noUnverifiedName, { right: 4, of: 4 });
});

test('P9-15: every uncertain line says why, and the recap leaves an uncertain decision open', () => {
  const uncertain = MATRIX_CASES.flatMap(c => c.utterances.filter(u => u.uncertain).map(u => ({ c, u })));
  assert.ok(uncertain.length >= 2);
  for (const { c, u } of uncertain) {
    assert.ok(u.uncertain!.length > 20, `${u.id} explains its uncertainty`);
    if (u.kind === 'decision') assert.equal(c.topics.find(t => t.id === u.topic)!.decision, null, `${u.id}: an uncertain decision is not recapped as decided`);
  }
});

test('P9-15: the new cases cover the incident, design review and retro, in Hebrew with English terms', () => {
  for (const id of ['design-review-he', 'incident-he', 'retro-he']) {
    const c = byId(id);
    assert.ok(c.utterances.every(u => /[֐-׿]/.test(u.text)), `${id} is Hebrew`);
    assert.ok(c.utterances.some(u => u.terms?.length), `${id} has English terms`);
  }
  const incident = byId('incident-he');
  assert.equal(Object.keys(incident.speakers).length, 4);
  assert.ok(incident.utterances.filter(u => u.overlaps).length >= 3);
  assert.equal(incident.actions[0]!.owner, 'S4', 'the voice that answered, not the name said aloud');
  assert.equal(incident.actions[1]!.owner, null);
  assert.ok(byId('retro-he').links.some(l => l.strength === 'clear'));
});

function goodRecord(turn: Turn): TurnRecord {
  const spoken = turn.expect.respond === 'speak' ? [`Here is what I found: ${(turn.expect.mentions ?? []).map(group => group[0]).join(', ') || 'nothing new'}.`] : [];
  const writes = turn.expect.write === 'task' ? [`task: ${(turn.expect.writeIncludes ?? ['x']).join(' ')}`] : [];
  return { index: 0, turn, script: String(turn.say), heard: String(turn.say), spoken, chat: [], writes, tools: (turn.expect.tools ?? []).map(tool => `${tool}: status = To Do`),
    spokeAfterUtterance: 0, interruptedByNoise: false, handRaisedBefore: false, events: [],
    timing: { speechStart: 0, speechEnd: 0, ...(spoken.length ? { firstAudio: 900 } : {}) } };
}

test('P9-15: the meeting-type voice scenarios are defined, scoreable offline, and kept out of a default run', () => {
  const names = MEETING_TYPE_SCENARIOS.map(s => s.name);
  assert.deepEqual(names, ['planning-sprint', 'incident-live', 'one-to-one-checkin', 'design-review-options', 'retro-backchannel']);
  const all = [...LAB_SCENARIOS, ...MEETING_TYPE_SCENARIOS].map(s => s.name);
  assert.equal(new Set(all).size, all.length, 'names are unique across both lists');
  assert.ok(MEETING_TYPE_SCENARIOS.every(s => !LAB_SCENARIOS.includes(s)), 'a plain voice-lab run does not include them');
  for (const scenario of MEETING_TYPE_SCENARIOS) {
    const ids = new Set(scenario.participants.map(p => p.id));
    assert.ok(scenario.participants.every(p => p.voice !== 'aura-2-thalia-en' && p.voice.endsWith('-en')), 'English lab voices, never hers');
    assert.ok(scenario.turns.some(t => t.expect.respond === 'silent' && t.expect.write === 'none'), `${scenario.name}: a line that must open nothing`);
    for (const turn of scenario.turns) {
      assert.ok(ids.has(turn.speaker));
      // A record that does what the turn expects passes; speaking or writing where it must not, fails.
      assert.equal(scoreTurn(goodRecord(turn)).passed, true, `${scenario.name}: ${String(turn.say)}`);
      if (turn.expect.respond === 'silent') {
        assert.equal(scoreTurn({ ...goodRecord(turn), spoken: ['Okay.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 500 } }).passed, false);
      }
      if (turn.expect.write === 'none') assert.equal(scoreTurn({ ...goodRecord(turn), writes: ['task: something'] }).passed, false);
    }
  }
  const source = readFileSync(new URL('../tools/voice-lab/scenarios.ts', import.meta.url), 'utf8');
  assert.match(source, /Language limitation: the lab speaks with English Deepgram voices/);
});

test('P9-15: every coverage cell shows its denominator', () => {
  const t = totals();
  const text = renderCoverage(buildCoverage(), t);
  assert.ok(text.includes(`| 0/${t.voiceLab} | 1/${t.voiceLabUnrun} |`));
  assert.match(text, /new ones defined offline and never run/);
  assert.equal(buildCoverage().find(r => r.value === 'Hebrew audio through the voice path')!.status, 'gap');
});
