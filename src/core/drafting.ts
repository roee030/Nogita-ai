/**
 * What the meeting said around "Nogita, open a ticket for that". The model writes the title and description; these
 * rules add the facts it should not have to paraphrase: the lines just before the request, with who said them, and the
 * person who already took the work on out loud ("I'll take it"). Transcript lines are "Name: text", oldest first.
 */
import { directlyAddressesNogita } from './policy.ts';

const QUOTE_LINES = 5;
const CLAIM_WINDOW = 6;
// "I'll take it", "I can handle that", "let me pick this up", "I've got it", "I'm on it". Not "I can see the error".
const CLAIM_SELF = /\b(?:(?:i'll|i will|i can|let me|i'm gonna|i am going to)\s+(?:take|handle|own|do|pick up|grab|look into|fix|deal with)(?:\s+(?:it|this|that|this one|that one))?\b|i(?:'ve| have)? got (?:it|this|that)\b|i'm on it\b|i am on it\b|that's mine\b)/i;

function split(line: string): { speaker: string; text: string } | undefined {
  const at = line.indexOf(': ');
  if (at <= 0 || at > 80) return undefined;
  return { speaker: line.slice(0, at).trim(), text: line.slice(at + 2).trim() };
}
const isNogita = (speaker: string) => /^nogita$/i.test(speaker);

/** The lines worth quoting in a task: said by people (not her), not addressed to her, long enough to carry meaning. */
export function meetingQuotes(lines: readonly string[]): Array<{ speaker: string; text: string }> {
  return lines.map(split).filter((line): line is { speaker: string; text: string } => line !== undefined)
    .filter(line => !isNogita(line.speaker) && !directlyAddressesNogita(line.text) && line.text.split(/\s+/).length >= 4)
    .slice(-QUOTE_LINES);
}

/**
 * Who already took the work on in the last few lines: the speaker of "I'll take it", or a named person who was
 * volunteered ("Dana can handle it"). The newest claim wins. A name, for the board's own people search to resolve.
 */
export function findVolunteer(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(-CLAIM_WINDOW).map(split).reverse()) {
    if (!line || isNogita(line.speaker) || directlyAddressesNogita(line.text)) continue;
    if (CLAIM_SELF.test(line.text)) return line.speaker;
    const named = line.text.match(/\b([A-Z][\p{L}'-]+)\s+(?:can|will|could|should|is going to|is gonna)\s+(?:take|handle|own|do|pick up|grab|look into)\b/u);
    if (named && !/^(?:it|that|this|we|you|they|he|she|someone|somebody|nogita)$/i.test(named[1]!)) return named[1];
  }
  return undefined;
}

/** The description with the quoted lines appended, inside the board's length limit. */
export function withMeetingQuotes(description: string, lines: readonly string[], max = 4000): string {
  const quotes = meetingQuotes(lines);
  if (!quotes.length) return description;
  const block = `\n\nSaid in the meeting just before the request:\n${quotes.map(q => `- ${q.speaker}: ${q.text.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}`;
  return `${description.slice(0, Math.max(0, max - block.length))}${block}`;
}

const ITEM_UNOWNED = [
  /\b(?:someone|somebody|we|you guys|one of us)\s+(?:really\s+)?(?:should|need to|needs to|have to|has to|must|ought to|gotta)\s+(.{8,})/i,
  /\b(?:let's|let us)\s+make sure\s+(?:that\s+)?(.{8,})/i,
  /\b(?:todo|action item)\s*[:,-]?\s+(.{8,})/i,
];
const ITEM_OWNED = /\b(?:i'll|i will|i'm going to|i am going to|i need to|i have to)\s+((?:fix|update|write|add|check|look into|send|review|ship|deploy|investigate|follow up|talk to|ask|prepare|create|remove|test|migrate|refactor|document|set up|clean up)\b.{3,})/i;
const ITEM_WINDOW = 4;
const MAX_ITEMS = 30;

// "We decided to ship on Monday", "let's go with the queue", "we agreed that Dana owns billing", "decision: no cron".
const DECISION = /\b(?:we(?:'ve| have)? decided|we agreed|we're going with|we are going with|we'll go with|let's go with|the decision is|decision is|decision:)\s*(?:to\s+|that\s+|on\s+)?(.{4,})/i;

/** One sentence of meeting speech as a decision the team made, if it says so plainly. */
export function decisionIn(speaker: string, text: string): { speaker: string; text: string } | undefined {
  if (isNogita(speaker) || directlyAddressesNogita(text) || /\?\s*$/.test(text)) return undefined;
  const found = text.match(DECISION);
  return found ? { speaker, text: found[1]!.replace(/\s+/g, ' ').trim().replace(/[.!,;]+$/, '').slice(0, 200) } : undefined;
}

export interface ActionItem { speaker: string; text: string; owner?: string }

/** One sentence of meeting speech as an action item, with its owner when the speaker took it on in the same breath. */
export function actionItemIn(speaker: string, text: string): ActionItem | undefined {
  if (isNogita(speaker) || directlyAddressesNogita(text)) return undefined;
  const tidy = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[.!?,;]+$/, '').slice(0, 160);
  const owned = text.match(ITEM_OWNED);
  if (owned) return { speaker, text: tidy(owned[1]!), owner: speaker };
  for (const pattern of ITEM_UNOWNED) {
    const found = text.match(pattern);
    if (found && !/\?\s*$/.test(text)) return { speaker, text: tidy(found[1]!) };
  }
  return undefined;
}

/**
 * The action items of one meeting, in memory only (purged with the meeting). A claim ("I'll take it") or a task
 * opened within a few lines gives the newest open item its owner, so "what's still open?" has a real answer.
 */
export class ActionItemTracker {
  private items: Array<ActionItem & { line: number }> = [];
  private said: Array<{ speaker: string; text: string }> = [];
  private line = 0;

  hear(speaker: string, text: string): void {
    this.line++;
    const decision = decisionIn(speaker, text);
    if (decision && this.said.length < MAX_ITEMS) this.said.push(decision);
    const item = actionItemIn(speaker, text);
    // "I'll look into it" names no work of its own: it claims what was just said.
    if (item?.owner && item.text.split(' ').length <= 4 && /\b(?:it|this|that|them|one)$/i.test(item.text)) {
      this.claim(speaker);
      return;
    }
    if (item) {
      this.items.push({ ...item, line: this.line });
      if (this.items.length > MAX_ITEMS) this.items.shift();
      return;
    }
    const volunteer = findVolunteer([`${speaker}: ${text}`]);
    if (volunteer) this.claim(volunteer);
  }

  /** A task was opened for what was just discussed. */
  taskCreated(label: string): void { this.claim(`task ${label}`); }

  private claim(owner: string): void {
    const open = [...this.items].reverse().find(item => !item.owner && this.line - item.line <= ITEM_WINDOW);
    if (open) open.owner = owner;
  }

  list(): ActionItem[] { return this.items.map(({ line: _line, ...item }) => ({ ...item })); }
  unowned(): ActionItem[] { return this.list().filter(item => !item.owner); }
  /** Decisions said plainly in this meeting, oldest first. */
  decisions(): Array<{ speaker: string; text: string }> { return this.said.map(item => ({ ...item })); }
  clear(): void { this.items = []; this.said = []; this.line = 0; }
}
