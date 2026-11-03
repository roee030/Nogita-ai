/**
 * Completion Gate: at the end of a turn, the actions the person asked for are compared with what the tools actually
 * did, without another model call. A turn in which an asked-for action did not happen is not a success, whatever the
 * answer says ("I opened all three" after two were created).
 *
 * Two checks, both conservative (when unsure, the turn is incomplete rather than wrongly complete):
 * - Every write that failed, or every batch item that failed, stays missing unless a later call did the same thing
 *   (same task title, same task key, same tool for other writes).
 * - When the request asks to create tasks, at least that many were created: the number it names ("open three tasks",
 *   "פתחי חמש משימות"), or one when it names none.
 */
import { HE_CREATE, HE_TASK, requestsTaskWrite } from './agent-tools.ts';
import type { ToolOutcome } from './agent.ts';

export interface GateCall { name: string; input: Record<string, unknown>; outcome: ToolOutcome; write: boolean }
export interface CompletionReport {
  complete: boolean;
  /** Task creations the request asked for; absent when it asked for none. */
  requestedTasks?: number;
  /** Tasks created this turn, counting one that a retried event had already created. */
  createdTasks: number;
  /** What was asked for or attempted and did not happen, one line each (tool output shortened, untrusted). */
  missing: string[];
}

const MAX_REASON_CHARS = 200;

const EN_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, couple: 2 };
const HE_NUMBERS: Record<string, number> = { 'אחת': 1, 'אחד': 1, 'שתי': 2, 'שתיים': 2, 'שני': 2, 'שניים': 2, 'שלוש': 3,
  'שלושה': 3, 'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5, 'שש': 6, 'שישה': 6, 'שבע': 7, 'שבעה': 7, 'שמונה': 8,
  'תשע': 9, 'תשעה': 9, 'עשר': 10, 'עשרה': 10 };
const EN_TASK = String.raw`(?:task|tasks|ticket|tickets|issue|issues|bug|bugs|story|stories|card|cards|todo|todos)`;
// Hebrew letters are not \w, so word edges are spelled out.
const HE_EDGE_BEFORE = String.raw`(?:^|[\s,.;:!?"'(])`;
const HE_EDGE_AFTER = String.raw`(?=[\s,.;:!?"')]|$)`;

/** How many tasks the request asks to create: the largest count on any one line, or undefined when it asks for none. */
export function requestedTaskCount(request: string): number | undefined {
  let best: number | undefined;
  for (const line of request.split('\n')) {
    const count = lineTaskCount(line);
    if (count !== undefined) best = Math.max(best ?? 0, count);
  }
  return best;
}

function lineTaskCount(line: string): number | undefined {
  const t = line.toLowerCase().replace(/\s+/g, ' ').trim();
  const english = requestsTaskWrite(t);
  const hebrew = new RegExp(`${HE_CREATE}.*${HE_TASK}`).test(t);
  if (!english && !hebrew) return undefined;
  let total = 0;
  if (english) {
    const words = Object.keys(EN_NUMBERS).join('|');
    const pattern = new RegExp(String.raw`\b(\d{1,2}|${words})\s+(?:[\w'-]+\s+){0,3}?${EN_TASK}\b`, 'g');
    for (const match of t.matchAll(pattern)) total += Number(match[1]) || EN_NUMBERS[match[1]!] || 0;
  }
  if (hebrew) {
    const words = Object.keys(HE_NUMBERS).join('|');
    // "חמש משימות" (number first) and "משימה אחת" (number after).
    const before = new RegExp(`${HE_EDGE_BEFORE}(\\d{1,2}|${words})\\s+${HE_TASK}${HE_EDGE_AFTER}`, 'g');
    const after = new RegExp(`${HE_EDGE_BEFORE}${HE_TASK}\\s+(${words})${HE_EDGE_AFTER}`, 'g');
    for (const match of [...t.matchAll(before), ...t.matchAll(after)]) total += Number(match[1]) || HE_NUMBERS[match[1]!] || 0;
  }
  // Asked to create, no number said ("open tasks for these", "log it"): at least one.
  return total || 1;
}

interface ItemResult { family: string; identity: string; label?: string; ok: boolean; reason?: string; created?: boolean }

/** One result per item a write touched: a batch call becomes one per item, in order. */
function itemResults(call: GateCall): ItemResult[] {
  const { name, input, outcome } = call;
  const reason = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
  if (name === 'create_task' || name === 'create_tasks' || name === 'update_task' || name === 'update_tasks') {
    const creating = name.startsWith('create');
    const list = name.endsWith('s') ? arrayOf(creating ? input.tasks : input.updates) : [input];
    const label = (item: Record<string, unknown>) => creating ? normalize(item.title) : normalize(item.key).toUpperCase();
    const family = creating ? 'create_task' : 'update_task';
    if (!name.endsWith('s') || outcome.isError && !/^\d+ of \d+ /m.test(outcome.content)) {
      // A single write, or a batch refused as a whole (permission, write cap, bad input): every item shares the outcome.
      return (list.length ? list : [{}]).map(item => ({ family, identity: label(item), ...(label(item) ? { label: label(item) } : {}), ok: !outcome.isError,
        created: creating && !outcome.isError, ...(outcome.isError ? { reason: reason(outcome.content) } : {}) }));
    }
    // A batch reports one numbered line per item; a line that does not start with what succeeded is a failure.
    const lines = outcome.content.split('\n');
    const success = creating ? /^Created\b/ : /^[A-Z][A-Z0-9_]+-\d+ /;
    return list.map((item, index) => {
      const line = lines.find(candidate => candidate.startsWith(`${index + 1}. `))?.slice(`${index + 1}. `.length) ?? '';
      const ok = success.test(line) && !/^Not\b/.test(line);
      return { family, identity: label(item), ...(label(item) ? { label: label(item) } : {}), ok, created: creating && ok, ...(ok ? {} : { reason: reason(line || outcome.content) }) };
    });
  }
  return [{ family: name, identity: name, ok: !outcome.isError, ...(outcome.isError ? { reason: reason(outcome.content) } : {}) }];
}

export function checkCompletion(request: string | undefined, calls: readonly GateCall[]): CompletionReport {
  const items = calls.filter(call => call.write).flatMap(itemResults);
  const missing: string[] = [];
  items.forEach((item, index) => {
    if (item.ok) return;
    // Fixed by a later call that did the same thing (the owner left out, the title shortened is not the same thing).
    if (items.slice(index + 1).some(later => later.ok && later.family === item.family && later.identity === item.identity)) return;
    missing.push(`${item.family}${item.label ? ` (${item.label})` : ''} failed: ${item.reason ?? 'no result'}`);
  });
  const createdTasks = items.filter(item => item.created).length;
  const requestedTasks = request ? requestedTaskCount(request) : undefined;
  if (requestedTasks !== undefined && createdTasks < requestedTasks) {
    missing.push(`created ${createdTasks} of ${requestedTasks} requested task${requestedTasks === 1 ? '' : 's'}`);
  }
  return { complete: missing.length === 0, ...(requestedTasks !== undefined ? { requestedTasks } : {}), createdTasks, missing };
}

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
