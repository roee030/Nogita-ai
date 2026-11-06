/**
 * The product test for one meeting (docs/WORK_PLAN.md, phase 8): did she interrupt, did anyone have to fix what she
 * made, and how many minutes did she save. Pure functions over the meeting's transcript, her tasks' change history and
 * what people wrote in the chat; `run.ts` fetches them.
 */
import { directlyAddressesNogita, normalizeWakeWord } from '../../src/core/policy.ts';

export interface Segment { speaker: string; start: number; end: number; text: string; nogita: boolean }
export interface Interruption { at: number; kind: 'talk_over' | 'kept_talking' | 'half_sentence' | 'not_addressed'; why: string }

/** Utterances closer than this belong to one of her answers. */
const BURST_GAP_MS = 1_000;
/** Someone who goes on within this long after a pause was not done. */
const RESUME_MS = 2_000;
/** She just spoke: a reply without her name may still be for her. */
const CONVERSATION_MS = 30_000;
/** Talking on this long after someone started (not a "mm-hm") is not stopping when interrupted. */
const KEPT_TALKING_MS = 1_500;
/** A sentence that ends on one of these was not finished ("…about all the."). */
const DANGLING = /\b(?:the|a|an|to|of|and|or|but|about|all|so|um|uh|for|with|in|on|that|this|my|our|your)[.?!,]*\s*$/i;

export function bursts(segments: readonly Segment[]): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const s of segments.filter(s => s.nogita).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start - last.end <= BURST_GAP_MS) { last.end = Math.max(last.end, s.end); last.text += ` ${s.text}`; }
    else out.push({ start: s.start, end: s.end, text: s.text });
  }
  return out;
}

/** Her answers that started over someone, or that answered talk not addressed to her. */
export function interruptions(segments: readonly Segment[]): Interruption[] {
  const people = segments.filter(s => !s.nogita).sort((a, b) => a.start - b.start);
  const answers = bursts(segments);
  const found: Interruption[] = [];
  answers.forEach((answer, i) => {
    const t = answer.start;
    const inside = people.find(s => t > s.start + 100 && t < s.end - 100);
    const before = people.filter(s => s.end <= t + 100).at(-1);
    const after = people.find(s => s.start >= t);
    if (inside) { found.push({ at: t, kind: 'talk_over', why: `started inside "${inside.text.slice(0, 50)}"` }); return; }
    if (before && after && after.speaker === before.speaker && after.start - before.end <= RESUME_MS && t >= before.end - 100) {
      found.push({ at: t, kind: 'talk_over', why: `started in the pause between "${before.text.slice(0, 40)}" and "${after.text.slice(0, 40)}"` });
      return;
    }
    if (!before) return;
    if (DANGLING.test(before.text.trim()) && t - before.end <= RESUME_MS) {
      found.push({ at: t, kind: 'half_sentence', why: `answered the unfinished "${before.text.slice(0, 50)}"` });
      return;
    }
    const previous = answers[i - 1];
    const inConversation = previous !== undefined && t - previous.end <= CONVERSATION_MS;
    const addressed = directlyAddressesNogita(normalizeWakeWord(before.text));
    if (!addressed && !inConversation) found.push({ at: t, kind: 'not_addressed', why: `answered "${before.text.slice(0, 50)}"` });
  });
  // Someone started talking while she spoke (more than a "mm-hm"), and she went on regardless.
  for (const answer of answers) {
    const over = people.find(s => s.start > answer.start + 300 && s.start < answer.end && answer.end - s.start > KEPT_TALKING_MS &&
      s.text.trim().split(/\s+/).length > 2);
    if (over) found.push({ at: over.start, kind: 'kept_talking', why: `went on ${((answer.end - over.start) / 1000).toFixed(1)} s over "${over.text.slice(0, 50)}"` });
  }
  return found.sort((a, b) => a.at - b.at);
}

export interface TaskHistory {
  key: string;
  created: number;
  /** Missing from Jira now (deleted). */
  deleted?: boolean;
  changes: Array<{ at: number; field: string }>;
}

/** Fields whose change means someone fixed what she wrote; moving through the workflow is not a correction. */
const CORRECTION_FIELDS = new Set(['summary', 'description', 'assignee', 'issuetype', 'project', 'priority', 'labels', 'duedate']);

export function corrections(tasks: readonly TaskHistory[], windowMs = 24 * 3_600_000): Array<{ key: string; why: string }> {
  return tasks.flatMap(task => {
    if (task.deleted) return [{ key: task.key, why: 'deleted' }];
    const fixed = [...new Set(task.changes.filter(change => change.at - task.created <= windowMs && CORRECTION_FIELDS.has(change.field))
      .map(change => change.field))];
    return fixed.length ? [{ key: task.key, why: `${fixed.join(', ')} changed` }] : [];
  });
}

/** "saved 15", "saved 15 minutes", "חסך 15", "חסכה לי 20 דקות": the largest number anyone wrote. */
export function minutesSaved(messages: readonly string[]): number | undefined {
  const values = messages.flatMap(text => [...text.matchAll(/(?:\bsaved\b|חסכ[הו]?|חסך)\D{0,15}?(\d{1,3})/giu)].map(m => Number(m[1])));
  return values.length ? Math.max(...values) : undefined;
}

export interface Scorecard {
  session: string;
  date: string;
  minutes: number;
  answers: number;
  interruptions: Interruption[];
  tasks: string[];
  corrections: Array<{ key: string; why: string }>;
  minutesSaved?: number;
  pass: boolean | null;
}

export const TARGETS = { interruptions: 0, corrections: 0, minutesSaved: 10 };

export function scorecard(input: { session: string; date: string; segments: Segment[]; tasks: TaskHistory[]; chat: string[];
  minutesSaved?: number }): Scorecard {
  const found = interruptions(input.segments);
  const fixed = corrections(input.tasks);
  const saved = input.minutesSaved ?? minutesSaved(input.chat);
  const span = input.segments.length ? Math.max(...input.segments.map(s => s.end)) - Math.min(...input.segments.map(s => s.start)) : 0;
  // Unknown minutes saved leaves the meeting undecided, never passed.
  const pass = found.length > TARGETS.interruptions || fixed.length > TARGETS.corrections || (saved !== undefined && saved < TARGETS.minutesSaved)
    ? false : saved === undefined ? null : true;
  return { session: input.session, date: input.date, minutes: Math.round(span / 60_000), answers: bursts(input.segments).length,
    interruptions: found, tasks: input.tasks.map(task => task.key), corrections: fixed, ...(saved !== undefined ? { minutesSaved: saved } : {}), pass };
}

export function markdown(card: Scorecard): string {
  const verdict = card.pass === true ? 'passed' : card.pass === false ? '**failed**' : 'undecided (minutes saved not given)';
  const lines = [`# Meeting scorecard: ${card.session} (${card.date})`, '',
    `**Result: ${verdict}.** Targets: ${TARGETS.interruptions} interruptions, ${TARGETS.corrections} corrections, at least ${TARGETS.minutesSaved} minutes saved.`, '',
    '| | Value | Target |', '|---|---|---|',
    `| Interruptions | ${card.interruptions.length} | 0 |`,
    `| Corrections to her output | ${card.corrections.length} (tasks she made: ${card.tasks.length ? card.tasks.join(', ') : 'none'}) | 0 |`,
    `| Minutes saved | ${card.minutesSaved ?? 'not given'} | ≥ 10 |`,
    `| Meeting length, her answers | ${card.minutes} min, ${card.answers} | |`, ''];
  if (card.interruptions.length) {
    lines.push('## Interruptions');
    const label = { talk_over: 'started over someone', kept_talking: 'kept talking', half_sentence: 'half-sentence', not_addressed: 'not addressed' };
    for (const item of card.interruptions) lines.push(`- ${new Date(item.at).toISOString().slice(11, 19)} ${label[item.kind]}: ${item.why}`);
    lines.push('');
  }
  if (card.corrections.length) {
    lines.push('## Corrections');
    for (const item of card.corrections) lines.push(`- ${item.key}: ${item.why}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** One row of docs/scorecards/README.md, and whether the last five rows in a row passed (the phase 8 gate). */
export function tableRow(card: Scorecard, file: string): string {
  const result = card.pass === true ? 'pass' : card.pass === false ? 'fail' : 'undecided';
  return `| ${card.date} | [${card.session}](${file}) | ${card.interruptions.length} | ${card.corrections.length} | ${card.minutesSaved ?? '-'} | ${result} |`;
}
export function gatePassed(rows: readonly string[]): boolean {
  const results = rows.map(row => row.split('|').map(cell => cell.trim()).at(-2));
  return results.length >= 5 && results.slice(-5).every(result => result === 'pass');
}
