import type { Actor, PolicyPort } from './contracts.ts';

export class AllowlistPolicy implements PolicyPort {
  constructor(private readonly authorized: ReadonlySet<string>) {}
  mayReadCode(actor: Actor): boolean { return actor.verified && this.authorized.has(actor.id); }
  mayWriteTask(actor: Actor): boolean { return actor.verified && this.authorized.has(actor.id); }
  mayDraftPR(actor: Actor): boolean { return false; } // Deliberately disabled until safe sandbox/review workflow exists.
}

/** Prevent a model from autonomously turning discussion into a write action. */
export function isExplicitCreateRequest(current: string): boolean {
  const t = current.toLowerCase();
  if (/\b(?:pr|pull request)\b/.test(t)) return false;
  return /\b(create|open|add|file|make)\b.{0,90}\b(task|ticket|issue|bug|story)\b/.test(t) ||
    /\b(task|ticket|issue|bug)\b.{0,40}\b(in|on)\s+jira\b/.test(t);
}
export function isExplicitPRRequest(current: string): boolean {
  return /\b(create|open|prepare|draft|make)\b.{0,90}\b(pr|pull request)\b/i.test(current);
}

export function isRepositoryOverviewQuestion(current: string): boolean {
  return /\b(?:project|product|repo|repository)\b/i.test(current) &&
    /\b(?:about|working on)\b/i.test(current) && /\b(?:what|explain|describe|tell me)\b/i.test(current);
}

export function isRepositoryConnectionQuestion(current: string): boolean {
  if (isRepositoryOverviewQuestion(current)) return false;
  return /\b(?:connected|connect|access)\b.{0,50}\b(?:repo|repository|github)\b/i.test(current)
    || /\b(?:repo|repository|github)\b.{0,50}\b(?:connected|connect|access)\b/i.test(current);
}

/** A fast hint for evidence retrieval. Ambiguous questions can still use the planner's inspect_code action. */
export function isRepositoryQuestion(current: string): boolean {
  return /\b(?:project|repo|repository|github|code|source|implementation|function|module|file|commit|push(?:ed)?|branch|merge|pull request|authentication|authorization|login|log-in|sign-in|webhook|endpoint|provider|configuration|database|deployment|architecture)\b/i.test(current);
}

export function isExplicitLeaveRequest(current: string): boolean {
  const text = current.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (current.trim().endsWith('?') && !/^(?:please\s+)?(?:can you|could you|would you)\s+/.test(text)) return false;
  return /^(?:(?:please|you can|can you|could you|would you)\s+)*(?:leave|exit|disconnect)(?:\s+(?:this|the)\s+(?:call|meeting))?(?:\s+(?:now|please))?$/.test(text)
    || /^(?:(?:please|you can|can you|could you|would you)\s+)*(?:drop|end)\s+(?:this|the)\s+(?:call|meeting)(?:\s+(?:now|please))?$/.test(text);
}

// Words that may follow the name without punctuation and still make it an address.
// Imperatives are included because recognition often drops the comma ("Nogita summarize the standup"), and
// "and" only before a question word ("Nogita and what starts it?").
const ADDRESS_FOLLOW = String.raw`what\b|why\b|where\b|when\b|who\b|how\b|which\b|can\b|could\b|would\b|will\b|please\b|tell\b|explain\b|show\b|say\b|do\b|check\b|help\b|drop\b|leave\b|exit\b|end\b|verify\b|hello\b|hi\b|i\b|you\b|we\b|summari[sz]e\w*|open\b|create\b|add\b|give\b|list\b|find\b|look\b|search\b|post\b|send\b|remind\b|repeat\b|go\b|stop\b|wait\b|read\b|make\b|write\b|and\s+(?:what|why|how|where|when|who|which)\b`;
// Greetings and spoken fillers that may come before the name ("Um, Nogita", "No, Nogita, ...", "So Nogita").
const ADDRESS_LEAD = String.raw`hey|hi|hello|okay|ok|please|excuse me|thanks|thank you|um|uh|erm|so|and|no|oh|well|yeah|yes|alright|right|sorry`;
// Speech recognition often writes a comma after the greeting: "Hey, Nogita, ...".
const initialAddress = new RegExp(String.raw`^(?:(?:${ADDRESS_LEAD}),?\s+)?nogita(?:\s*[,.:!?-]\s*|\s+(?=${ADDRESS_FOLLOW}))`, 'i');
const laterAddress = new RegExp(String.raw`[.!?;]\s+(?:(?:${ADDRESS_LEAD}),?\s+)?nogita(?:\s*[,.:!?-]\s*|\s+(?=${ADDRESS_FOLLOW}))`, 'i');
// The name between commas right before a question or request: "So for the retry logic, Nogita, what happens...".
// A list ("Dana, Nogita, and Avi") does not match because "and" is not a follow word.
const vocativeAddress = new RegExp(String.raw`,\s+nogita\s*,\s+(?=${ADDRESS_FOLLOW})`, 'i');

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Speech recognition hears the wake word as "Nokita", "Notita", "Nikita", "Lokita" or "No Gita" even with keyterm
 * prompting (measured in the voice lab). Where an address can stand (start of a turn, after a greeting or a
 * sentence end), a word within two edits of "nogita" is restored, so the address rules below still apply.
 * Mid-sentence mentions are left alone.
 */
export function normalizeWakeWord(text: string): string {
  return text.replace(
    new RegExp(String.raw`(^|[.!?;]\s+)((?:(?:${ADDRESS_LEAD}),?\s+)?)(no\s+g[a-z]{2,3}|[nlm][a-z]{4,6})(?=\s*[,.:!?-]|\s+(?:${ADDRESS_FOLLOW}))`, 'gi'),
    (match, lead: string, greeting: string, word: string) =>
      word.toLowerCase() !== 'nogita' && editDistance(word.toLowerCase().replace(/\s+/g, ''), 'nogita') <= 2
        ? `${lead}${greeting}Nogita` : match);
}

/** Prevent simple third-person name mentions from activating the bot. */
export function directlyAddressesNogita(text: string): boolean {
  const s = text.trim();
  return initialAddress.test(s)
    || laterAddress.test(s)
    || vocativeAddress.test(s)
    || /^(?:how are you|are you|can you|could you|would you|what do you think|how about you),?\s+nogita\b/i.test(s)
    || /\b(?:can you|could you|would you|what do you think|how about you),?\s+nogita[?!.]?$/i.test(s);
}
export function removeAddress(text: string): string {
  if (initialAddress.test(text)) return text.replace(initialAddress, '').trim();
  if (laterAddress.test(text)) return text.slice(text.search(laterAddress)).replace(laterAddress, '').trim();
  return text.replace(/,?\s*nogita\s*,?/i, ' ').replace(/\s+([?!.])/g, '$1').replace(/\s+/g, ' ').trim();
}
