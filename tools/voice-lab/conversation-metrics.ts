/**
 * Conversation management, measured from the whole event log of a scenario: what became of every question
 * (answered aloud, only in chat, cancelled, lost), how often an early start was used or rolled back, whether
 * Nogita ever began speaking while someone was talking, and whether a cut-off answer was finished.
 */
import type { LabEvent } from './rig.ts';

export interface QuestionEntry {
  id: number;
  speaker: string;
  request: string;
  topic?: string;
  statuses: string[];
  final: string;
  notes: string[];
  earlyStart: boolean;
}

export interface ConversationStats {
  /** Questions Nogita took on (an early start rolled back before confirmation does not count). */
  questions: number;
  answered: number;
  /** Answered, but some of the spoken answer never played (it is in chat). */
  chatOnly: number;
  cancelled: number;
  stopped: number;
  failed: number;
  /** Still open when the scenario ended: an answer that never came. */
  unresolved: number;
  /** Answered aloud / questions not withdrawn by the asker. */
  completion?: number;
  askedAgain: number;
  /** Answers to the first half of a question, dropped when the speaker went on after a pause. */
  restarted: number;
  earlyStarts: number;
  earlyAdopted: number;
  earlyRolledBack: number;
  cutOff: number;
  resumed: number;
  /** Nogita started speaking while a participant was mid-sentence. */
  spokeOverPeople: number;
  /** The same task or message written more than once. */
  duplicateWrites: number;
}

const QUESTION = /^#(\d+) (\w+)(?: \[([^\]]+)\])?(?:: (.*))?$/;

export function questionLedger(events: readonly LabEvent[]): QuestionEntry[] {
  const entries = new Map<number, QuestionEntry>();
  for (const event of events) {
    if (event.type !== 'question') continue;
    const match = QUESTION.exec(event.detail ?? '');
    if (!match) continue;
    const id = Number(match[1]);
    const entry = entries.get(id) ?? { id, speaker: (event.participant ?? '').replace(/^lab_/, ''), request: event.text ?? '',
      statuses: [], final: '', notes: [], earlyStart: false };
    const status = match[2]!;
    if (match[3]) entry.topic = match[3];
    if (match[4]) entry.notes.push(match[4]);
    if (status === 'speculative') entry.earlyStart = true;
    if (entry.statuses.at(-1) !== status) entry.statuses.push(status);
    entry.final = status;
    entries.set(id, entry);
  }
  return [...entries.values()];
}

/** When each participant was speaking, from the lab's speech marks. */
function speechIntervals(events: readonly LabEvent[]): Array<[number, number]> {
  const open = new Map<string, number>();
  const intervals: Array<[number, number]> = [];
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.type === 'speech_start') open.set(event.participant ?? '', event.t);
    if (event.type === 'speech_end' && open.has(event.participant ?? '')) {
      intervals.push([open.get(event.participant ?? '')!, event.t]);
      open.delete(event.participant ?? '');
    }
  }
  return intervals;
}

export function conversationStats(logs: ReadonlyArray<readonly LabEvent[]>): ConversationStats {
  const stats: ConversationStats = { questions: 0, answered: 0, chatOnly: 0, cancelled: 0, stopped: 0, failed: 0, unresolved: 0,
    askedAgain: 0, restarted: 0, earlyStarts: 0, earlyAdopted: 0, earlyRolledBack: 0, cutOff: 0, resumed: 0, spokeOverPeople: 0, duplicateWrites: 0 };
  for (const events of logs) {
    for (const entry of questionLedger(events)) {
      if (entry.earlyStart) stats.earlyStarts++;
      if (entry.final === 'rolled_back') { stats.earlyRolledBack++; continue; }
      // Replaced by the whole question once the speaker went on after a pause.
      if (entry.final === 'superseded') { stats.restarted++; continue; }
      if (entry.earlyStart) stats.earlyAdopted++;
      stats.questions++;
      stats.askedAgain += entry.notes.filter(note => /asked again/.test(note)).length;
      if (entry.statuses.includes('interrupted')) stats.cutOff++;
      stats.resumed += entry.notes.filter(note => note === 'resumed').length;
      if (entry.final === 'answered') stats.answered++;
      else if (entry.final === 'chat_only') stats.chatOnly++;
      else if (entry.final === 'cancelled') stats.cancelled++;
      else if (entry.final === 'stopped') stats.stopped++;
      else if (entry.final === 'failed') stats.failed++;
      else stats.unresolved++;
    }
    // Starting to speak while someone is mid-sentence (they started more than a moment before her).
    const intervals = speechIntervals(events);
    stats.spokeOverPeople += events.filter(event => event.type === 'audio_start' &&
      intervals.some(([start, end]) => event.t > start + 300 && event.t < end)).length;
    const writes = events.filter(event => event.type === 'write').map(event => event.text ?? '');
    stats.duplicateWrites += writes.length - new Set(writes).size;
  }
  const wanted = stats.questions - stats.cancelled - stats.stopped;
  if (wanted > 0) stats.completion = Math.round(stats.answered / wanted * 1000) / 1000;
  return stats;
}
