/**
 * P9-15 (partial): one coverage view over the tools that already exist (docs/VOICE_PRODUCT_ROADMAP.md, "One matrix
 * across existing tools"): the voice lab scenarios, the eval cases, the labeled meeting types and the synthetic matrix
 * cases. It counts what each covers; it runs nothing and changes nothing. "Blocked" rows wait on a named task.
 */
import { SCENARIOS, type Scenario } from '../voice-lab/scenarios.ts';
import { CASES, type EvalCase } from '../../tests/eval/cases.ts';
import { LABELED } from '../meeting-profile/labels.ts';
import { PROFILES } from '../../src/core/meeting-profile.ts';
import { MATRIX_CASES, type MeetingCase } from './cases.ts';

export type Status = 'covered' | 'thin' | 'gap' | 'blocked';
export interface Sources { voiceLab: number; eval: number; profiles: number; matrix: number }
export interface Row { dimension: string; value: string; sources: Sources; status: Status; note?: string }

const HEBREW = /[֐-׿]/;
const said = (scenario: Scenario) => scenario.turns.flatMap(turn => Array.isArray(turn.say) ? turn.say : [turn.say]);
const count = <T>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).length;

export interface Inputs { scenarios: readonly Scenario[]; cases: readonly EvalCase[]; labeled: typeof LABELED; matrix: readonly MeetingCase[] }

/** Which eval groups and voice-lab scenario names exercise a meeting type. */
const EVAL_GROUP_TYPE: Partial<Record<EvalCase['group'], string>> = { retro: 'retro', design_review: 'design_review', incidents: 'incident' };
const SCENARIO_TYPE: Array<[RegExp, string]> = [[/standup/, 'standup'], [/team-discussion|meeting-room/, 'general']];
const MATRIX_TYPE: Record<string, string> = { 'daily-drift-he': 'standup', 'planning-he': 'planning', 'one-to-one-he': 'one_to_one' };

function status(sources: Sources, minimum = 3): Status {
  const total = sources.voiceLab + sources.eval + sources.profiles + sources.matrix;
  return total === 0 ? 'gap' : total < minimum ? 'thin' : 'covered';
}

export function buildCoverage(inputs: Inputs = { scenarios: SCENARIOS, cases: CASES, labeled: LABELED, matrix: MATRIX_CASES }): Row[] {
  const { scenarios, cases, labeled, matrix } = inputs;
  const rows: Row[] = [];
  const add = (dimension: string, value: string, sources: Sources, note?: string, forced?: Status) =>
    rows.push({ dimension, value, sources, status: forced ?? status(sources), ...(note ? { note } : {}) });

  for (const profile of PROFILES.filter(p => p !== 'uncertain')) {
    const sources = {
      voiceLab: count(scenarios, s => SCENARIO_TYPE.some(([pattern, type]) => type === profile && pattern.test(s.name))),
      eval: count(cases, c => EVAL_GROUP_TYPE[c.group] === profile),
      profiles: count(labeled, l => l.profile === profile),
      matrix: count(matrix, m => MATRIX_TYPE[m.id] === profile),
    };
    // Inference labels say what a meeting is; they don't test how she behaves in one.
    const behaviour = sources.voiceLab + sources.eval + sources.matrix;
    add('meeting type', profile, sources, behaviour ? undefined : 'labels only: no behaviour case in this type yet',
      behaviour === 0 ? 'gap' : behaviour < 2 ? 'thin' : 'covered');
  }

  const hebrew = {
    voiceLab: count(scenarios, s => said(s).some(line => HEBREW.test(line))),
    eval: count(cases, c => c.turns.some(turn => HEBREW.test(turn))),
    profiles: count(labeled, l => l.lines.some(line => HEBREW.test(line))),
    matrix: count(matrix, m => m.utterances.some(u => HEBREW.test(u.text))),
  };
  // Nogita's meetings are mostly Hebrew, so a handful of cases is thin; no Hebrew audio at all is a gap of its own.
  add('language', 'Hebrew, or Hebrew with English terms', hebrew,
    'voice lab audio is English TTS; Hebrew audio needs real or consented recordings', status(hebrew, 10));
  add('language', 'Hebrew audio through the voice path', { ...hebrew, eval: 0, profiles: 0, matrix: 0 },
    'needs consented or synthetic Hebrew audio', hebrew.voiceLab ? undefined : 'gap');

  add('speakers', 'four or more voices', {
    voiceLab: count(scenarios, s => new Set(s.turns.map(t => t.speaker)).size >= 4),
    eval: count(cases, c => new Set(c.speakers ?? []).size >= 4),
    profiles: count(labeled, l => new Set(l.lines.map(line => line.split(':')[0])).size >= 4),
    matrix: count(matrix, m => Object.keys(m.speakers).length >= 4),
  });
  add('cross-talk', 'two people at once', {
    voiceLab: count(scenarios, s => s.turns.some(t => t.overlapPreviousMs !== undefined)),
    eval: 0, profiles: 0, matrix: count(matrix, m => m.utterances.some(u => u.overlaps?.length)),
  });
  add('short acknowledgements', 'backchannels', {
    voiceLab: count(scenarios, s => s.turns.some(t => t.bargeIn?.kind === 'backchannel')),
    eval: 0, profiles: 0, matrix: count(matrix, m => m.utterances.some(u => u.kind === 'backchannel')),
  });
  add('topics', 'a daily that drifts into design and planning', {
    voiceLab: 0, eval: 0, profiles: 0, matrix: count(matrix, m => new Set(m.utterances.map(u => u.topic)).size >= 3),
  }, 'recap behaviour on a drifting meeting still needs a live-model case (P9-17)');
  add('statements', 'decision vs proposal vs blocker vs question', {
    voiceLab: 0, eval: count(cases, c => c.group === 'decisions' || c.group === 'recap'),
    profiles: 0, matrix: count(matrix, m => new Set(m.utterances.map(u => u.kind)).size >= 4),
  });
  add('ownership', 'owner or date not established', {
    voiceLab: 0, eval: count(cases, c => c.group === 'unknown_owner'),
    profiles: 0, matrix: count(matrix, m => m.actions.some(a => a.owner === null || a.due === null)),
  });
  add('approval', 'writes only for the exact approved items', {
    voiceLab: 0, eval: count(cases, c => c.group === 'unasked_writes' || c.group === 'recap'),
    profiles: 0, matrix: count(matrix, m => m.actions.length > 0),
  });
  add('approval', 'a Plan Agent suggestion waits for the user', {
    voiceLab: 0, eval: 0, profiles: 0, matrix: count(matrix, m => m.utterances.some(u => /plan agent/i.test(u.text))),
  }, 'transcript-level only: Nogita has no Plan Agent of its own');

  const none: Sources = { voiceLab: 0, eval: 0, profiles: 0, matrix: 0 };
  add('screen', 'compressed fixtures, change gate, reading accuracy', none, 'waits on the real screen test (P8-13) and P9-14', 'blocked');
  add('provider failure', 'chat silently not delivered', none, 'Attendee reports no failure; needs the P8-12 smoke test to know what to simulate', 'blocked');
  add('meeting type', 'inference in real meetings', none, 'waits on P9-9', 'blocked');
  add('grading', 'judge agreement with human labels', none, 'tool ready (agreement.ts); human labels are P9-18', 'blocked');
  return rows;
}

export function renderCoverage(rows: readonly Row[]): string {
  const header = ['| Dimension | Value | Voice lab | Eval | Type labels | Matrix | Status | Note |', '|---|---|---|---|---|---|---|---|'];
  const body = rows.map(r => `| ${r.dimension} | ${r.value} | ${r.sources.voiceLab} | ${r.sources.eval} | ${r.sources.profiles} | ${r.sources.matrix} | ${r.status} | ${r.note ?? ''} |`);
  const tally = (s: Status) => rows.filter(r => r.status === s).length;
  return [...header, ...body, '',
    `Rows: ${rows.length}. Covered ${tally('covered')}, thin ${tally('thin')}, gap ${tally('gap')}, blocked ${tally('blocked')}.`,
    'Counts are cases or scenarios that exercise the value, from the files themselves. "Thin" is fewer than 3 (2 for meeting-type behaviour, 10 for Hebrew). These are diagnostics, not gates.'].join('\n');
}
