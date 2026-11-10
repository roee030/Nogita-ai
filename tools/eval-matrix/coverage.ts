/**
 * P9-15 (partial): one coverage view over the tools that already exist (docs/VOICE_PRODUCT_ROADMAP.md, "One matrix
 * across existing tools"): the voice lab scenarios, the eval cases, the labeled meeting types and the synthetic matrix
 * cases. It counts what each covers, as count/total of that source; it runs nothing and changes nothing. Voice-lab
 * scenarios defined but never run are shown apart and do not make a row covered. "Blocked" rows wait on a named task.
 */
import { MEETING_TYPE_SCENARIOS, SCENARIOS, type Scenario } from '../voice-lab/scenarios.ts';
import { CASES, type EvalCase } from '../../tests/eval/cases.ts';
import { LABELED } from '../meeting-profile/labels.ts';
import { PROFILES } from '../../src/core/meeting-profile.ts';
import { MATRIX_CASES, type MeetingCase } from './cases.ts';

export type Status = 'covered' | 'thin' | 'gap' | 'blocked';
/** Counts per source. `voiceLabUnrun` are scenarios defined offline that no paid run has confirmed yet. */
export interface Sources { voiceLab: number; voiceLabUnrun: number; eval: number; profiles: number; matrix: number }
export interface Row { dimension: string; value: string; sources: Sources; status: Status; note?: string }
export interface Totals { voiceLab: number; voiceLabUnrun: number; eval: number; profiles: number; matrix: number }

const HEBREW = /[֐-׿]/;
const said = (scenario: Scenario) => scenario.turns.flatMap(turn => Array.isArray(turn.say) ? turn.say : [turn.say]);
const count = <T>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).length;

export interface Inputs {
  scenarios: readonly Scenario[]; unrun: readonly Scenario[]; cases: readonly EvalCase[]; labeled: typeof LABELED; matrix: readonly MeetingCase[];
}
export const DEFAULT_INPUTS: Inputs = { scenarios: SCENARIOS, unrun: MEETING_TYPE_SCENARIOS, cases: CASES, labeled: LABELED, matrix: MATRIX_CASES };

/** Which eval groups, voice-lab scenario names and matrix cases exercise a meeting type. */
const EVAL_GROUP_TYPE: Partial<Record<EvalCase['group'], string>> = { retro: 'retro', design_review: 'design_review', incidents: 'incident' };
const SCENARIO_TYPE: Array<[RegExp, string]> = [[/standup/, 'standup'], [/team-discussion|meeting-room/, 'general'],
  [/^planning-/, 'planning'], [/^incident-/, 'incident'], [/^one-to-one-/, 'one_to_one'], [/^design-review-/, 'design_review'], [/^retro-/, 'retro']];
const MATRIX_TYPE: Record<string, string> = { 'daily-drift-he': 'standup', 'planning-he': 'planning', 'one-to-one-he': 'one_to_one',
  'design-review-he': 'design_review', 'incident-he': 'incident', 'retro-he': 'retro' };

/** Rows count as covered at `minimum` confirmed cases; unrun voice-lab scenarios never count. */
function status(sources: Sources, minimum = 3): Status {
  const total = sources.voiceLab + sources.eval + sources.profiles + sources.matrix;
  return total === 0 ? 'gap' : total < minimum ? 'thin' : 'covered';
}

export function totals(inputs: Inputs = DEFAULT_INPUTS): Totals {
  return { voiceLab: inputs.scenarios.length, voiceLabUnrun: inputs.unrun.length, eval: inputs.cases.length,
    profiles: inputs.labeled.length, matrix: inputs.matrix.length };
}

export function buildCoverage(inputs: Inputs = DEFAULT_INPUTS): Row[] {
  const { scenarios, unrun, cases, labeled, matrix } = inputs;
  const rows: Row[] = [];
  const add = (dimension: string, value: string, sources: Partial<Sources>, note?: string, forced?: Status) => {
    const full: Sources = { voiceLab: 0, voiceLabUnrun: 0, eval: 0, profiles: 0, matrix: 0, ...sources };
    rows.push({ dimension, value, sources: full, status: forced ?? status(full), ...(note ? { note } : {}) });
  };
  const lab = (test: (s: Scenario) => boolean) => ({ voiceLab: count(scenarios, test), voiceLabUnrun: count(unrun, test) });

  for (const profile of PROFILES.filter(p => p !== 'uncertain')) {
    const isType = (s: Scenario) => SCENARIO_TYPE.some(([pattern, type]) => type === profile && pattern.test(s.name));
    const sources = { ...lab(isType), eval: count(cases, c => EVAL_GROUP_TYPE[c.group] === profile),
      profiles: count(labeled, l => l.profile === profile), matrix: count(matrix, m => MATRIX_TYPE[m.id] === profile) };
    // Inference labels say what a meeting is; they don't test how she behaves in one.
    const behaviour = sources.voiceLab + sources.eval + sources.matrix;
    const notes = [behaviour ? '' : 'labels only: no behaviour case yet', sources.voiceLabUnrun ? 'voice-lab scenario defined, not run' : '']
      .filter(Boolean).join('; ');
    add('meeting type', profile, sources, notes || undefined, behaviour === 0 ? 'gap' : behaviour < 2 ? 'thin' : 'covered');
  }

  const hebrew = { ...lab(s => said(s).some(line => HEBREW.test(line))),
    eval: count(cases, c => c.turns.some(turn => HEBREW.test(turn))),
    profiles: count(labeled, l => l.lines.some(line => HEBREW.test(line))),
    matrix: count(matrix, m => m.utterances.some(u => HEBREW.test(u.text))) };
  // Nogita's meetings are mostly Hebrew, so fewer than 10 cases is thin; no Hebrew audio at all is a gap of its own.
  add('language', 'Hebrew, or Hebrew with English terms (text)', { ...hebrew, voiceLab: 0, voiceLabUnrun: 0 },
    'transcript level only', status({ ...hebrew, voiceLab: 0, voiceLabUnrun: 0 }, 10));
  add('language', 'Hebrew audio through the voice path', { voiceLab: hebrew.voiceLab, voiceLabUnrun: hebrew.voiceLabUnrun },
    'the voice lab speaks with English Deepgram voices only; needs consented or synthetic Hebrew audio');
  add('language', 'English technical terms inside Hebrew lines', { matrix: count(matrix, m => m.utterances.some(u => HEBREW.test(u.text) && u.terms?.length)) });

  add('speakers', 'four or more voices', { ...lab(s => new Set(s.turns.map(t => t.speaker)).size >= 4),
    eval: count(cases, c => new Set(c.speakers ?? []).size >= 4),
    profiles: count(labeled, l => new Set(l.lines.map(line => line.split(':')[0])).size >= 4),
    matrix: count(matrix, m => Object.keys(m.speakers).length >= 4) });
  add('speakers', 'a name said aloud is not a verified identity', {
    matrix: count(matrix, m => m.actions.some(a => a.owner) && Object.values(m.speakers).every(s => !s?.verifiedName)) },
    'owners are voices (S1–S4) unless the call verified a name');
  add('cross-talk', 'two people at once', { ...lab(s => s.turns.some(t => t.overlapPreviousMs !== undefined)),
    matrix: count(matrix, m => m.utterances.some(u => u.overlaps?.length)) });
  add('short acknowledgements', 'backchannels', { ...lab(s => s.turns.some(t => t.bargeIn?.kind === 'backchannel')),
    matrix: count(matrix, m => m.utterances.some(u => u.kind === 'backchannel')) });

  add('topics', 'a meeting that drifts across three or more topics', {
    matrix: count(matrix, m => new Set(m.utterances.map(u => u.topic)).size >= 3) },
    'recap behaviour on a drifting meeting still needs a live-model run (P9-17)');
  add('topics', 'links between topics, clear and uncertain', {
    matrix: count(matrix, m => m.links.some(l => l.strength === 'clear')) + count(matrix, m => m.links.some(l => l.strength === 'uncertain')) },
    'counted once for a case with a clear link and once for a case with an uncertain one');

  add('statements', 'decision vs proposal vs blocker vs question', { eval: count(cases, c => c.group === 'decisions' || c.group === 'recap'),
    matrix: count(matrix, m => new Set(m.utterances.map(u => u.kind)).size >= 4) });
  add('statements', 'a proposal next to a decision on the same topic', {
    ...lab(s => s.turns.some(t => /maybe|probably|think about it/i.test(String(t.say)) && t.expect.write === 'none')),
    matrix: count(matrix, m => m.topics.some(t => m.utterances.some(u => u.topic === t.id && u.kind === 'proposal')
      && m.utterances.some(u => u.topic === t.id && u.kind === 'decision'))) });
  add('statements', 'a line labeled uncertain on purpose', { matrix: count(matrix, m => m.utterances.some(u => u.uncertain)) },
    'not scored either way; the reviewer confirms the uncertainty');

  add('ownership', 'owner or date not established', { eval: count(cases, c => c.group === 'unknown_owner'),
    matrix: count(matrix, m => m.actions.some(a => a.owner === null || a.due === null)) });
  add('ownership', '"I\'ll look into it" or "if needed" is not an owner', { matrix: count(matrix, m => m.actions.some(a => a.tentativeOwner)) });

  add('approval', 'nothing written without approval', { eval: count(cases, c => c.group === 'unasked_writes'),
    ...lab(s => s.turns.some(t => t.expect.write === 'none' && !/nogita/i.test(String(t.say)))),
    matrix: count(matrix, m => m.actions.length > 0 && m.approval.approvedInMeeting.length === 0) });
  add('approval', 'exactly the approved items are written', { eval: count(cases, c => c.group === 'recap'),
    matrix: count(matrix, m => m.approval.approvedInMeeting.length > 0) });
  add('approval', 'a Plan Agent suggestion waits for the user', { matrix: count(matrix, m => m.utterances.some(u => /plan agent/i.test(u.text))) },
    'transcript level only: Nogita has no Plan Agent of its own');

  add('screen', 'compressed fixtures, change gate, reading accuracy', {}, 'waits on the real screen test (P8-13) and P9-14', 'blocked');
  add('provider failure', 'chat silently not delivered', {}, 'simulated offline (tests/chat-silent-drop.test.ts: 3 cases, 2 known gaps); P8-12 says which is real', 'blocked');
  add('meeting type', 'inference in real meetings', {}, 'waits on P9-9', 'blocked');
  add('grading', 'judge agreement with human labels', {}, 'tools ready (agreement.ts, blind label-sheet.ts, recap-adapter.ts); human labels are P9-18', 'blocked');
  return rows;
}

export function renderCoverage(rows: readonly Row[], total: Totals = totals()): string {
  const header = [`| Dimension | Value | Voice lab | Voice lab (new, never run) | Eval | Type labels | Matrix | Status | Note |`,
    '|---|---|---|---|---|---|---|---|---|'];
  const n = (value: number, of: number) => `${value}/${of}`;
  const body = rows.map(r => `| ${r.dimension} | ${r.value} | ${n(r.sources.voiceLab, total.voiceLab)} | ${n(r.sources.voiceLabUnrun, total.voiceLabUnrun)} | ${n(r.sources.eval, total.eval)} | ${n(r.sources.profiles, total.profiles)} | ${n(r.sources.matrix, total.matrix)} | ${r.status} | ${r.note ?? ''} |`);
  const tally = (s: Status) => rows.filter(r => r.status === s).length;
  return [...header, ...body, '',
    `Rows: ${rows.length}. Covered ${tally('covered')}, thin ${tally('thin')}, gap ${tally('gap')}, blocked ${tally('blocked')}.`,
    `Each cell is cases or scenarios that exercise the value, out of all in that source: voice lab ${total.voiceLab} scenarios plus ${total.voiceLabUnrun} new ones defined offline and never run, eval ${total.eval}, type labels ${total.profiles}, matrix ${total.matrix}.`,
    '"Thin" is fewer than 3 confirmed cases (2 for meeting-type behaviour, 10 for Hebrew text). Scenarios that were never run do not count. These are diagnostics, not gates.'].join('\n');
}
