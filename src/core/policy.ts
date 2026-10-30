import type { Actor, PolicyPort } from './contracts.ts';

export class AllowlistPolicy implements PolicyPort {
  /** `draftPullRequests`: the team turned on draft PRs (a new branch with a note, never a merge). Off unless configured. */
  constructor(private readonly authorized: ReadonlySet<string>, private readonly options: { draftPullRequests?: boolean } = {}) {}
  mayReadCode(actor: Actor): boolean { return actor.verified && this.authorized.has(actor.id); }
  mayWriteTask(actor: Actor): boolean { return actor.verified && this.authorized.has(actor.id); }
  mayDraftPR(actor: Actor): boolean { return this.options.draftPullRequests === true && this.mayWriteTask(actor); }
}

/** Prevent a model from autonomously turning discussion into a write action. */
export function isExplicitCreateRequest(current: string): boolean {
  const t = current.toLowerCase();
  if (/\b(?:pr|pull request)\b/.test(t)) return false;
  return /\b(create|open|add|file|make)\b.{0,90}\b(task|ticket|issue|bug|story)\b/.test(t) ||
    /\b(task|ticket|issue|bug)\b.{0,40}\b(in|on)\s+jira\b/.test(t) ||
    // Right after one task: "and open one for me to ...", "create another for Dana".
    /\b(create|open|add|file|make)\s+(?:one|another|one more)\s+(?:for|to|about|on)\b/.test(t);
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

// Courtesy people wrap a goodbye in: "thanks, that's all, you can leave now, thank you".
const LEAVE_COURTESY_BEFORE = /^(?:(?:thanks|thank you(?: so much| very much)?|great|perfect|cool|nice|alright|all right|that's all|that is all|that's it|that is it|that's everything|we're done|we are done|we're good|we are good|we're all set|we are all set|nothing else)[,.;\s]+)+/;
const LEAVE_COURTESY_AFTER = /(?:[,.;\s]+(?:thanks|thank you(?: so much| very much)?|bye(?: bye)?|goodbye|see you(?: later)?|cheers|everyone|nogita))+$/;

export function isExplicitLeaveRequest(current: string): boolean {
  const raw = current.trim().toLowerCase().replace(/[‘’]/g, "'");
  const question = raw.endsWith('?');
  let text = raw.replace(/[.!?]+$/, '').trim().replace(LEAVE_COURTESY_BEFORE, '');
  // "Bye", "goodbye everyone", "bye bye, Nogita".
  if (!question && /^(?:bye(?: bye)?|good ?bye|see you(?: later)?|see ya)(?:[,\s]+(?:everyone|all|guys|nogita|now|for now))*$/.test(text)) return true;
  text = text.replace(LEAVE_COURTESY_AFTER, '').trim();
  if (question && !/^(?:please\s+)?(?:can you|could you|would you)\s+/.test(text)) return false;
  // "You can drop", "drop from this meeting" and "dropped from the call" (as recognition hears it) mean leave too.
  return /^(?:(?:ok(?:ay)?|now|please|you can|you may|can you|could you|would you|go ahead and|feel free to|you're free to|you are free to|i need you to|i want you to|it's time to|time to|time for you to)[,\s]+)*(?:leave|exit|disconnect|head\s+out|hang\s+up|sign\s+off|log\s+off|get\s+(?:off|out)|drop(?:ped)?(?:\s+(?:off|out))?)(?:\s+(?:from|of))?(?:\s+(?:this|the|our)\s+(?:call|meeting))?(?:\s+us)?(?:[,\s]+(?:now|please|for now|for today))*$/.test(text)
    // "Go" only with a lead that makes it a dismissal: "you can go", "time to go"; never "go ahead".
    || /^(?:(?:ok(?:ay)?|please|you can|you may|feel free to|you're free to|you are free to|it's time to|time to|time for you to)[,\s]+)+go(?:[,\s]+(?:now|please|for now|for today))*$/.test(text)
    || /^(?:(?:please|you can|can you|could you|would you)\s+)*end\s+(?:this|the)\s+(?:call|meeting)(?:\s+(?:now|please))?$/.test(text);
}

// Words that may follow the name without punctuation and still make it an address.
// Imperatives are included because recognition often drops the comma ("Nogita summarize the standup"), and
// "and" only before a question word ("Nogita and what starts it?").
const ADDRESS_FOLLOW = String.raw`what\b|why\b|where\b|when\b|who\b|how\b|which\b|can\b|could\b|would\b|will\b|please\b|tell\b|explain\b|show\b|say\b|do\b|check\b|help\b|drop\b|leave\b|exit\b|end\b|verify\b|hello\b|hi\b|i\b|you\b|we\b|summari[sz]e\w*|open\b|create\b|add\b|give\b|list\b|find\b|look\b|search\b|post\b|send\b|remind\b|repeat\b|go\b|stop\b|wait\b|read\b|make\b|write\b|walk\b|take\b|handle\b|figure\b|approve\b|decline\b|cancel\b|resume\b|review\b|describe\b|move\b|in\s+(?:one|two|a\s+few|short|brief)\b|and\s+(?:what|why|how|where|when|who|which)\b`;
// Greetings and spoken fillers that may come before the name ("Um, Nogita", "No, Nogita, ...", "So Nogita").
const ADDRESS_LEAD = String.raw`hey|hi|hello|okay|ok|please|excuse me|thanks|thank you|um|uh|erm|so|and|no|oh|well|yeah|yes|alright|right|sorry`;
// Speech recognition often writes a comma after the greeting: "Hey, Nogita, ...".
const initialAddress = new RegExp(String.raw`^(?:(?:${ADDRESS_LEAD}),?\s+)?nogita(?:\s*[,.:!?-]\s*|\s+(?=${ADDRESS_FOLLOW}))`, 'i');
// A question that opens with her name, when recognition drops the comma: "Nogita should this go in a queue?",
// "Nogita in one sentence, what is this?". Third-person questions ("Nogita was down?") do not count.
const questionAddress = new RegExp(String.raw`^(?:(?:${ADDRESS_LEAD}),?\s+)?nogita\s+(?!(?:is|was|has|had|said|did|does)\b)[^.!?]*\?\s*$`, 'i');
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
  // Two-word mishearings from a live Meet: "No, Gita", "no guitar", "Now, git", "the guitar".
  text = text.replace(new RegExp(String.raw`(^|[.!?;]\s+)((?:(?:${ADDRESS_LEAD}),?\s+)?)(?:no|now|the)[,.]?\s+g(?:ita|eeta|uitar|it)\b(?=\s*[,.:!?-]|\s+(?:${ADDRESS_FOLLOW})|\s*$)`, 'gi'),
    (_match, lead: string, greeting: string) => `${lead}${greeting}Nogita`);
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
    || questionAddress.test(s)
    || laterAddress.test(s)
    || vocativeAddress.test(s)
    || /^(?:how are you|are you|can you|could you|would you|what do you think|how about you),?\s+nogita\b/i.test(s)
    || /\b(?:can you|could you|would you|what do you think|how about you),?\s+nogita[?!.]?$/i.test(s);
}
export function removeAddress(text: string): string {
  if (initialAddress.test(text)) return text.replace(initialAddress, '').trim();
  if (questionAddress.test(text)) return text.replace(/^[^]*?nogita\s+/i, '').trim();
  if (laterAddress.test(text)) return text.slice(text.search(laterAddress)).replace(laterAddress, '').trim();
  return text.replace(/,?\s*nogita\s*,?/i, ' ').replace(/\s+([?!.])/g, '$1').replace(/\s+/g, ' ').trim();
}
