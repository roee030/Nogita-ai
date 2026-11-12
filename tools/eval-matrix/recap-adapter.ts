/**
 * P9-15 (partial): scores the product's own meeting recap (src/core/recap.ts, NOGITA_MEETING_RECAP) against a matrix case,
 * on layers 5 (actions and uncertainty) and 6 (write authorization). The recap is built by the same `buildRecap` the
 * engine uses; only the model differs. Offline, a scripted model answers; a live run passes a real model and is a paid
 * call that needs Roee's budget approval first (docs/EVAL_MATRIX_RUNBOOK.md). Nothing here changes the product.
 *
 * Matching a proposed task to an expected action is by the action's `match` terms, which is mechanical and can be wrong:
 * an unmatched task shows as "not proposed", never as a pass. The scores are diagnostic until a person reviews them.
 */
import type { ChatModel, ChatModelResponse } from '../../src/core/agent.ts';
import { buildRecap, parseApproval, type MeetingRecap } from '../../src/core/recap.ts';
import type { MeetingCase, Speaker } from './cases.ts';
import type { SystemOutput } from './score.ts';

/** The case as the recap reads it: "<who>: <words>", where who is the verified name or the voice label (S1..S4). */
export function matrixTranscript(meeting: MeetingCase): Array<{ text: string }> {
  return meeting.utterances.map(u => ({ text: `${meeting.speakers[u.speaker]?.verifiedName ?? u.speaker}: ${u.text}` }));
}

/** A model that answers with fixed text and records what it was asked; for offline runs. */
export function scriptedModel(answer: string): ChatModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    agentModel: 'scripted',
    prompts,
    async streamChat(request): Promise<ChatModelResponse> {
      prompts.push(request.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'));
      return { content: [{ type: 'text', text: answer }], stopReason: 'end_turn' };
    },
  };
}

/** Due dates as the cases spell them, and how a recap may say them. Anything else is kept as said, and scores as wrong. */
const DUE_ALIASES: Record<string, RegExp> = {
  'Thursday': /^(?:by |until |on )?(?:thursday|thu|יום חמישי|חמישי|עד חמישי|עד יום חמישי)$/i,
  'now': /^(?:now|right now|immediately|right away|asap|עכשיו|מיד)$/i,
  'end of sprint': /^(?:by |until )?(?:the )?end of (?:the )?sprint$|^(?:עד )?סוף (?:ה)?ספרינט$/i,
};
const due = (said: string | undefined): string | null => {
  if (!said) return null;
  const clean = said.trim();
  return Object.entries(DUE_ALIASES).find(([, alias]) => alias.test(clean))?.[0] ?? clean;
};

/** A recap's owner as a voice label: a verified name maps back to its voice; any other name stays, and scores as wrong. */
const owner = (meeting: MeetingCase, said: string | undefined): Speaker | string | null => {
  if (!said) return null;
  const verified = (Object.entries(meeting.speakers) as Array<[Speaker, { verifiedName?: string }]>)
    .find(([, s]) => s.verifiedName?.toLowerCase() === said.trim().toLowerCase());
  return verified ? verified[0] : said.trim();
};

/** The case action (1-based) a piece of recap text is about, or undefined. The first action whose terms appear wins. */
export function matchAction(meeting: MeetingCase, text: string): number | undefined {
  const t = text.toLowerCase();
  const index = meeting.actions.findIndex(action => action.match.some(term => t.includes(term.toLowerCase())));
  return index < 0 ? undefined : index + 1;
}

export interface RecapRun {
  recap: MeetingRecap | undefined;
  output: SystemOutput;
  /** Recap items that matched no expected action: possibly invented, for a person to look at. */
  unmatched: string[];
}

/**
 * Layers 5 and 6 from a recap. An action's owner and due come from the recap's "who does what" item for it, or else from
 * its proposed task. `approval` is what a person said after the recap ("approve 1"), and opens recap task numbers, which
 * are mapped to case actions; no approval means nothing is written.
 */
export function recapOutput(meeting: MeetingCase, recap: MeetingRecap | undefined, approval?: string): RecapRun {
  if (!recap) return { recap, output: { actions: [], writes: [] }, unmatched: [] };
  const actions = new Map<number, { matches: number; owner: Speaker | string | null; due: string | null }>();
  const unmatched: string[] = [];
  for (const item of recap.actionItems) {
    const n = matchAction(meeting, item.what);
    if (n === undefined) { unmatched.push(item.what); continue; }
    if (!actions.has(n)) actions.set(n, { matches: n, owner: owner(meeting, item.owner), due: due(item.due) });
  }
  // By title only: a description often names a neighboring topic ("the Plan Agent suggested it") and would match it.
  const taskToAction = recap.proposedTasks.map(task => matchAction(meeting, task.title));
  recap.proposedTasks.forEach((task, i) => {
    const n = taskToAction[i];
    if (n === undefined) { unmatched.push(task.title); return; }
    if (!actions.has(n)) actions.set(n, { matches: n, owner: owner(meeting, task.owner), due: null });
  });
  const approved = approval === undefined ? undefined : parseApproval(approval);
  const opened = approved === 'all' ? recap.proposedTasks.map((_, i) => i + 1) : approved ?? [];
  // Every opened task is one write, so the unapproved-write count is never merged away: two tasks for the same expected
  // action are two writes, and a task tied to no expected action is -1, which never matches an approved item.
  const writes = [...new Set(opened)].filter(n => n <= recap.proposedTasks.length).map(n => taskToAction[n - 1] ?? -1);
  return { recap, output: { actions: [...actions.values()].sort((a, b) => a.matches - b.matches), writes }, unmatched: [...new Set(unmatched)] };
}

/** Builds the recap with the product's own code and scores it. */
export async function runRecap(model: ChatModel, meeting: MeetingCase, approval?: string): Promise<RecapRun> {
  return recapOutput(meeting, await buildRecap(model, matrixTranscript(meeting), `eval-matrix:${meeting.id}`), approval);
}
