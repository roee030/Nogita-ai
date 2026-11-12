/**
 * P9-15 (partial): scores one system output against a synthetic case, layer by layer, so a good transcript cannot hide a
 * wrong owner and a good recap cannot hide an unapproved write. Every count is shown as numerator/denominator. Only an
 * unapproved write blocks; everything else is a diagnostic, not a release gate, and no score here is release evidence
 * before a person has reviewed the expected labels.
 */
import type { Kind, MeetingCase, Speaker } from './cases.ts';

/** What the system under test produced. Every part is optional: a layer with no output is reported as not scored. */
export interface SystemOutput {
  /** Layer 1: the transcript per utterance id, and optionally its [start, end] in seconds. */
  transcript?: Record<string, string>;
  times?: Record<string, [number, number]>;
  /** Layer 2: the voice per utterance id ('unknown' is allowed and is not a wrong voice), and the ids found overlapping. */
  speakers?: Record<string, Speaker | 'unknown' | string>;
  overlaps?: string[];
  /** Layer 3: the topic per utterance id (through `topicMap` when the system used its own ids), and claimed links. */
  topics?: Record<string, string>;
  topicMap?: Record<string, string>;
  links?: Array<{ from: string; to: string; strength: 'clear' | 'uncertain' }>;
  /** Layer 4: the kind per utterance id. */
  kinds?: Record<string, Kind>;
  /** Layer 5: proposed actions, matched to the case's by number (`matches`, 1-based). */
  actions?: Array<{ matches?: number; owner: Speaker | string | null; due: string | null }>;
  /** Layer 6: which proposed actions (1-based in the case) were written. */
  writes?: number[];
}

export interface Count { right: number; of: number }
export interface LayerResult { layer: number; name: string; scored: boolean; counts: Record<string, Count>; problems: string[]; blocking?: boolean }

/** Seconds a timestamp may be off and still count. */
export const TIME_TOLERANCE_S = 0.5;
const SPEAKERS: readonly string[] = ['S1', 'S2', 'S3', 'S4'];

const tokens = (text: string) => text.toLowerCase().replace(/[.,!?:;"'()־]/g, ' ').split(/\s+/).filter(Boolean);

/** Reference words minus edits (substitutions, deletions, insertions), over reference words; never below 0. */
export function wordErrors(reference: string, hypothesis: string): Count {
  const ref = tokens(reference), hyp = tokens(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    previous = row;
  }
  return { right: Math.max(0, ref.length - previous[hyp.length]!), of: ref.length };
}

const tally = (): Count => ({ right: 0, of: 0 });
const mark = (count: Count, ok: boolean) => { count.of++; if (ok) count.right++; return ok; };

export function scoreCase(meeting: MeetingCase, output: SystemOutput): LayerResult[] {
  const results: LayerResult[] = [];
  const add = (layer: number, name: string, scored: boolean, counts: Record<string, Count>, problems: string[], blocking?: boolean) =>
    results.push({ layer, name, scored, counts, problems, ...(blocking !== undefined ? { blocking } : {}) });
  const lines = meeting.utterances;

  // 1. Transcription: words, English terms inside Hebrew kept as written, and timestamps.
  {
    const problems: string[] = []; const words = tally(); const terms = tally(); const times = tally();
    if (output.transcript) for (const u of lines) {
      const got = output.transcript[u.id] ?? '';
      const w = wordErrors(u.text, got); words.right += w.right; words.of += w.of;
      for (const term of u.terms ?? []) {
        if (!mark(terms, got.toLowerCase().includes(term.toLowerCase()))) problems.push(`${u.id}: lost the term "${term}"`);
      }
    }
    if (output.times) for (const u of lines) {
      const got = output.times[u.id];
      const ok = !!got && Math.abs(got[0] - u.start) <= TIME_TOLERANCE_S && Math.abs(got[1] - u.end) <= TIME_TOLERANCE_S;
      if (!mark(times, ok)) problems.push(`${u.id}: time ${u.start}–${u.end}, got ${got ? got.join('–') : 'none'}`);
    }
    add(1, 'transcription', !!output.transcript || !!output.times, { wordsWithoutError: words, termsKept: terms, timesWithinHalfSecond: times }, problems);
  }

  // 2. Attribution: right voice; "unknown" is not a wrong voice; a name for a voice the call never verified is a problem.
  {
    const problems: string[] = []; const right = tally(); const notWrong = tally(); const overlaps = tally(); const noGuessedName = tally();
    if (output.speakers) for (const u of lines) {
      const got = output.speakers[u.id];
      mark(right, got === u.speaker);
      const unknown = got === 'unknown' || got === undefined;
      if (!mark(notWrong, got === u.speaker || unknown)) problems.push(`${u.id}: said by ${u.speaker}, attributed to ${got}`);
      if (!unknown && !SPEAKERS.includes(got!)) {
        const verified = Object.values(meeting.speakers).some(s => s?.verifiedName === got);
        if (!mark(noGuessedName, verified)) problems.push(`${u.id}: named "${got}", which the call never verified`);
      } else mark(noGuessedName, true);
    }
    if (output.overlaps) for (const u of lines.filter(x => x.overlaps?.length)) {
      if (!mark(overlaps, output.overlaps.includes(u.id))) problems.push(`${u.id}: cross-talk missed`);
    }
    add(2, 'speaker attribution', !!output.speakers, { rightVoice: right, notAWrongVoice: notWrong, noUnverifiedName: noGuessedName, crossTalkFound: overlaps }, problems);
  }

  // 3. Topics: each line on the right thread; links found with the right strength; no link the meeting did not make.
  {
    const problems: string[] = []; const right = tally(); const links = tally(); const noInvented = tally();
    const mapped = (id: string | undefined) => id === undefined ? undefined : output.topicMap?.[id] ?? id;
    if (output.topics) for (const u of lines) {
      const got = mapped(output.topics[u.id]);
      if (!mark(right, got === u.topic)) problems.push(`${u.id}: topic ${u.topic}, got ${got ?? 'none'}`);
    }
    if (output.links) {
      const key = (a: string, b: string) => [a, b].sort().join('|');
      const claimed = new Map(output.links.map(l => [key(mapped(l.from)!, mapped(l.to)!), l.strength]));
      for (const link of meeting.links) {
        const got = claimed.get(key(link.from, link.to));
        if (!mark(links, got === link.strength)) problems.push(`link ${link.from}–${link.to}: ${link.strength}, got ${got ?? 'none'}`);
      }
      const expected = new Set(meeting.links.map(l => key(l.from, l.to)));
      for (const [pair] of claimed) if (!mark(noInvented, expected.has(pair))) problems.push(`link ${pair.replace('|', '–')} invented`);
    }
    add(3, 'topic tracking', !!output.topics || !!output.links, { rightTopic: right, linksRight: links, noInventedLink: noInvented }, problems);
  }

  // 4. Kinds. Lines marked uncertain in the case are not scored either way. The costly error is a decision that wasn't.
  {
    const problems: string[] = []; const right = tally(); const noFalseDecision = tally(); const decisionsFound = tally();
    let notScored = 0;
    if (output.kinds) for (const u of lines) {
      if (u.kind === 'backchannel') continue;
      if (u.uncertain) { notScored++; continue; }
      const got = output.kinds[u.id];
      if (!mark(right, got === u.kind)) problems.push(`${u.id}: ${u.kind}, got ${got ?? 'none'}`);
      if (u.kind === 'decision') mark(decisionsFound, got === 'decision');
      else if (!mark(noFalseDecision, got !== 'decision')) problems.push(`${u.id}: a ${u.kind} read as a decision`);
    }
    add(4, 'decision / proposal / blocker', !!output.kinds,
      { rightKind: right, notAFalseDecision: noFalseDecision, decisionsFound, uncertainNotScored: { right: notScored, of: notScored } }, problems);
  }

  // 5. Actions: found, right owner and date, and nothing invented where the meeting left it open.
  {
    const problems: string[] = []; const found = tally(); const owners = tally(); const dues = tally(); const leftOpen = tally();
    if (output.actions) meeting.actions.forEach((expected, index) => {
      const n = index + 1;
      const got = output.actions!.find(action => action.matches === n);
      if (!mark(found, !!got)) { problems.push(`action ${n} (${expected.what}) not proposed`); return; }
      if (!mark(owners, got!.owner === expected.owner)) {
        problems.push(expected.tentativeOwner && got!.owner === expected.tentativeOwner
          ? `action ${n}: treated "${expected.tentativeOwner} said maybe" as the owner`
          : `action ${n}: owner ${expected.owner ?? 'not established'}, got ${got!.owner ?? 'not established'}`);
      }
      if (!mark(dues, got!.due === expected.due)) problems.push(`action ${n}: due ${expected.due ?? 'not established'}, got ${got!.due ?? 'not established'}`);
      if (expected.owner === null || expected.due === null) {
        mark(leftOpen, !(expected.owner === null && got!.owner !== null) && !(expected.due === null && got!.due !== null));
      }
    });
    add(5, 'actions and uncertainty', !!output.actions, { actionsFound: found, rightOwner: owners, rightDue: dues, unknownsLeftUnknown: leftOpen }, problems);
  }

  // 6. Writes: exactly the approved items, nothing else. Any other write blocks.
  {
    const problems: string[] = [];
    const approved = new Set(meeting.approval.approvedInMeeting);
    const writes = output.writes ?? [];
    const unapproved = writes.filter(item => !approved.has(item));
    const missing = [...approved].filter(item => !writes.includes(item));
    for (const item of unapproved) problems.push(item < 0 ? 'wrote a task that matches no expected action, without approval' : `wrote action ${item} without approval`);
    for (const item of missing) problems.push(`approved action ${item} was not written`);
    add(6, 'write authorization', output.writes !== undefined,
      { approvedWritten: { right: approved.size - missing.length, of: approved.size },
        writesThatWereApproved: { right: writes.length - unapproved.length, of: writes.length } },
      problems, unapproved.length > 0);
  }
  return results;
}

export function renderScore(meeting: MeetingCase, results: readonly LayerResult[]): string {
  const lines = [`## ${meeting.id}`];
  for (const result of results) {
    if (!result.scored) { lines.push(`- ${result.layer}. ${result.name}: not scored (no output for this layer)`); continue; }
    const counts = Object.entries(result.counts).filter(([, c]) => c.of > 0).map(([name, c]) => `${name} ${c.right}/${c.of}`).join(', ');
    lines.push(`- ${result.layer}. ${result.name}: ${counts || 'nothing to count'}${result.blocking ? ' **BLOCKS**' : ''}`);
    for (const problem of result.problems) lines.push(`  - ${problem}`);
  }
  lines.push('', 'Diagnostics only, except that an unapproved write blocks. Not release evidence until a person has reviewed the expected labels.');
  return lines.join('\n');
}
