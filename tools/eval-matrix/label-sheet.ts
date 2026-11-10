/**
 * P9-15 (partial), for P9-18: a blind label sheet. A person marks each item of a system's output right or wrong without
 * seeing the automated verdict; the verdicts are computed only when the two are compared. The "judge" here is the
 * mechanical scorer (score.ts, recap-adapter.ts), the first grader whose agreement with a person has to be known; a model
 * judge, once there is one, is compared the same way. Nothing here is a gate.
 */
import type { MeetingCase } from './cases.ts';
import type { SystemOutput } from './score.ts';
import type { Rating } from './agreement.ts';

export type Verdict = 'right' | 'wrong';
export interface LabelItem {
  caseId: string;
  /** A line id ("u09"), "action 2" or "write 3". */
  item: string;
  dimension: 'voice' | 'statement type' | 'action owner' | 'action due' | 'write allowed';
  /** What the system produced, for the person to judge against the transcript. */
  got: string;
  /** Filled in by the person: "right" or "wrong". Empty means not labeled yet. */
  human: Verdict | '';
}

interface Judged extends Omit<LabelItem, 'human'> { judge: Verdict }

/** Every item the scorer would grade, with its verdict. Lines a case marks uncertain are left out, as in score.ts. */
function judged(meeting: MeetingCase, output: SystemOutput): Judged[] {
  const items: Judged[] = [];
  const verdict = (ok: boolean): Verdict => ok ? 'right' : 'wrong';
  for (const u of meeting.utterances) {
    const voice = output.speakers?.[u.id];
    if (voice !== undefined) items.push({ caseId: meeting.id, item: u.id, dimension: 'voice', got: voice, judge: verdict(voice === u.speaker) });
    const kind = output.kinds?.[u.id];
    if (kind !== undefined && !u.uncertain) items.push({ caseId: meeting.id, item: u.id, dimension: 'statement type', got: kind, judge: verdict(kind === u.kind) });
  }
  meeting.actions.forEach((expected, i) => {
    const got = output.actions?.find(action => action.matches === i + 1);
    if (!got) return;
    items.push({ caseId: meeting.id, item: `action ${i + 1}`, dimension: 'action owner', got: got.owner ?? 'not established', judge: verdict(got.owner === expected.owner) });
    items.push({ caseId: meeting.id, item: `action ${i + 1}`, dimension: 'action due', got: got.due ?? 'not established', judge: verdict(got.due === expected.due) });
  });
  const approved = new Set(meeting.approval.approvedInMeeting);
  for (const write of output.writes ?? []) {
    items.push({ caseId: meeting.id, item: `write ${write}`, dimension: 'write allowed',
      got: write < 0 ? 'wrote a task matching no expected action' : `wrote action ${write}`, judge: verdict(approved.has(write)) });
  }
  return items;
}

/** The sheet a person fills: what the system said, no verdicts. */
export function labelSheet(meeting: MeetingCase, output: SystemOutput): LabelItem[] {
  return judged(meeting, output).map(({ judge: _judge, ...item }) => ({ ...item, human: '' }));
}

const key = (item: Pick<LabelItem, 'caseId' | 'item' | 'dimension'>) => `${item.caseId}|${item.dimension}|${item.item}`;

/**
 * Joins a filled sheet with the scorer's verdicts on the same output. Items the person left empty are counted, not rated;
 * an item on the sheet the scorer does not grade (the output changed since) is reported, never guessed.
 */
export function compareLabels(meeting: MeetingCase, output: SystemOutput, sheet: readonly LabelItem[]):
  { ratings: Rating[]; unlabeled: number; stale: string[] } {
  const verdicts = new Map(judged(meeting, output).map(item => [key(item), item]));
  const ratings: Rating[] = []; const stale: string[] = []; let unlabeled = 0;
  for (const item of sheet.filter(entry => entry.caseId === meeting.id)) {
    const machine = verdicts.get(key(item));
    if (!machine || machine.got !== item.got) { stale.push(key(item)); continue; }
    if (item.human !== 'right' && item.human !== 'wrong') { unlabeled++; continue; }
    ratings.push({ caseId: `${item.caseId} ${item.item}`, dimension: item.dimension, judge: machine.judge, human: item.human });
  }
  return { ratings, unlabeled, stale };
}
