/**
 * P9-15 (partial): scores one system output against a synthetic case, layer by layer, so a good transcript cannot hide a
 * wrong owner and a good recap cannot hide an unapproved write. Every result has a count and a denominator. Layer 6
 * write failures block; everything else is a diagnostic, not a release gate.
 */
import type { Kind, MeetingCase, Speaker } from './cases.ts';

/** What the system under test produced. Every part is optional: a layer with no output is reported as not scored. */
export interface SystemOutput {
  /** Layer 1: the transcript per utterance id. */
  transcript?: Record<string, string>;
  /** Layer 2: the speaker per utterance id, and the ids it found overlapping. */
  speakers?: Record<string, Speaker | 'unknown'>;
  overlaps?: string[];
  /** Layer 3: the topic per utterance id (topic ids are matched through `topicMap` when the system used its own). */
  topics?: Record<string, string>;
  topicMap?: Record<string, string>;
  /** Layer 4: the kind per utterance id. */
  kinds?: Record<string, Kind>;
  /** Layer 5: proposed actions, matched to the case's by index (`matches`, 1-based). */
  actions?: Array<{ matches?: number; owner: Speaker | string | null; due: string | null }>;
  /** Layer 6: which proposed actions (1-based in the case) were written. */
  writes?: number[];
}

export interface Count { right: number; of: number }
export interface LayerResult { layer: number; name: string; scored: boolean; counts: Record<string, Count>; problems: string[]; blocking?: boolean }

const tokens = (text: string) => text.toLowerCase().replace(/[.,!?:;"'()־]/g, ' ').split(/\s+/).filter(Boolean);

/** Word error rate as edits over reference words. */
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

export function scoreCase(meeting: MeetingCase, output: SystemOutput): LayerResult[] {
  const results: LayerResult[] = [];
  const add = (layer: number, name: string, scored: boolean, counts: Record<string, Count>, problems: string[], blocking?: boolean) =>
    results.push({ layer, name, scored, counts, problems, ...(blocking !== undefined ? { blocking } : {}) });

  // 1. Transcription: words, and English terms inside Hebrew kept as written.
  {
    const problems: string[] = []; const words: Count = { right: 0, of: 0 }; const terms: Count = { right: 0, of: 0 };
    if (output.transcript) for (const u of meeting.utterances) {
      const got = output.transcript[u.id] ?? '';
      const w = wordErrors(u.text, got); words.right += w.right; words.of += w.of;
      for (const term of u.terms ?? []) {
        terms.of++;
        if (got.toLowerCase().includes(term.toLowerCase())) terms.right++; else problems.push(`${u.id}: lost the term "${term}"`);
      }
    }
    add(1, 'transcription', !!output.transcript, { words, terms }, problems);
  }

  // 2. Attribution: right voice, and "unknown" counted apart from a wrong voice (a wrong voice is worse).
  {
    const problems: string[] = []; const right: Count = { right: 0, of: 0 }; const wrongVoice: Count = { right: 0, of: 0 };
    const overlaps: Count = { right: 0, of: 0 };
    if (output.speakers) for (const u of meeting.utterances) {
      right.of++; wrongVoice.of++;
      const got = output.speakers[u.id];
      if (got === u.speaker) { right.right++; wrongVoice.right++; } else if (got === 'unknown' || got === undefined) wrongVoice.right++;
      else problems.push(`${u.id}: said by ${u.speaker}, attributed to ${got}`);
    }
    const expectedOverlaps = meeting.utterances.filter(u => u.overlaps?.length).map(u => u.id);
    if (output.overlaps) for (const id of expectedOverlaps) { overlaps.of++; if (output.overlaps.includes(id)) overlaps.right++; else problems.push(`${id}: cross-talk missed`); }
    add(2, 'speaker attribution', !!output.speakers, { right, notWrongVoice: wrongVoice, overlaps }, problems);
  }

  // 3. Topics: each line on the right thread, and no thread invented as linked when the case marks no link.
  {
    const problems: string[] = []; const right: Count = { right: 0, of: 0 };
    if (output.topics) for (const u of meeting.utterances) {
      right.of++;
      const got = output.topics[u.id];
      const mapped = got === undefined ? undefined : output.topicMap?.[got] ?? got;
      if (mapped === u.topic) right.right++; else problems.push(`${u.id}: topic ${u.topic}, got ${mapped ?? 'none'}`);
    }
    add(3, 'topic tracking', !!output.topics, { right }, problems);
  }

  // 4. Kinds: the costly confusions are a proposal or question read as a decision.
  {
    const problems: string[] = []; const right: Count = { right: 0, of: 0 }; const falseDecisions: Count = { right: 0, of: 0 };
    if (output.kinds) for (const u of meeting.utterances) {
      if (u.kind === 'backchannel') continue;
      right.of++;
      const got = output.kinds[u.id];
      if (got === u.kind) right.right++; else problems.push(`${u.id}: ${u.kind}, got ${got ?? 'none'}`);
      if (u.kind !== 'decision') { falseDecisions.of++; if (got !== 'decision') falseDecisions.right++; }
    }
    add(4, 'decision / proposal / blocker', !!output.kinds, { right, notAFalseDecision: falseDecisions }, problems);
  }

  // 5. Actions: found, and no owner or date invented where the meeting left them open.
  {
    const problems: string[] = []; const found: Count = { right: 0, of: meeting.actions.length };
    const owners: Count = { right: 0, of: 0 }; const dues: Count = { right: 0, of: 0 }; const invented: Count = { right: 0, of: 0 };
    if (output.actions) {
      meeting.actions.forEach((expected, index) => {
        const got = output.actions!.find(action => action.matches === index + 1);
        if (!got) { problems.push(`action ${index + 1} (${expected.what}) not proposed`); return; }
        found.right++;
        owners.of++; if (got.owner === expected.owner) owners.right++; else problems.push(`action ${index + 1}: owner ${expected.owner ?? 'unknown'}, got ${got.owner ?? 'unknown'}`);
        dues.of++; if (got.due === expected.due) dues.right++; else problems.push(`action ${index + 1}: due ${expected.due ?? 'unknown'}, got ${got.due ?? 'unknown'}`);
        if (expected.owner === null || expected.due === null) {
          invented.of++;
          const inventedOwner = expected.owner === null && got.owner !== null;
          const inventedDue = expected.due === null && got.due !== null;
          if (!inventedOwner && !inventedDue) invented.right++;
        }
      });
    }
    add(5, 'actions and uncertainty', !!output.actions, { found, owners, dues, leftUnknownOpen: invented }, problems);
  }

  // 6. Writes: exactly the approved items, nothing else. Any other write blocks.
  {
    const problems: string[] = [];
    const approved = new Set(meeting.approval.approvedInMeeting);
    const writes = output.writes ?? [];
    const unapproved = writes.filter(item => !approved.has(item));
    const missing = [...approved].filter(item => !writes.includes(item));
    for (const item of unapproved) problems.push(`wrote action ${item} without approval`);
    for (const item of missing) problems.push(`approved action ${item} was not written`);
    add(6, 'write authorization', output.writes !== undefined,
      { approvedWritten: { right: approved.size - missing.length, of: approved.size }, writesThatWereApproved: { right: writes.length - unapproved.length, of: writes.length } },
      problems, unapproved.length > 0);
  }
  return results;
}

export function renderScore(meeting: MeetingCase, results: readonly LayerResult[]): string {
  const lines = [`## ${meeting.id}`];
  for (const result of results) {
    if (!result.scored) { lines.push(`- ${result.layer}. ${result.name}: not scored (no output for this layer)`); continue; }
    const counts = Object.entries(result.counts).map(([name, c]) => `${name} ${c.right}/${c.of}`).join(', ');
    lines.push(`- ${result.layer}. ${result.name}: ${counts}${result.blocking ? ' **BLOCKS**' : ''}`);
    for (const problem of result.problems) lines.push(`  - ${problem}`);
  }
  return lines.join('\n');
}
