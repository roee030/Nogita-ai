/**
 * Text she is about to say, made to sound like a person talking: no markdown or links, no assistant-speak
 * ("Certainly!", "Great question"), and names written for the eye (paths, ticket keys, camelCase) turned into
 * what a colleague would actually say. The chat copy keeps the original text.
 */

// Openers that mark a chatbot, not a colleague. Only at the start of a sentence.
const ASSISTANT_OPENERS = new RegExp(String.raw`(^|[.!?]\s+)(?:(?:` + [
  String.raw`great question`, String.raw`good question`, String.raw`excellent question`, String.raw`that's a great question`,
  String.raw`that is a great question`, String.raw`i'd be happy to help(?: with that)?`, String.raw`i would be happy to help(?: with that)?`,
  String.raw`i'd be glad to help`, String.raw`happy to help`, String.raw`as an ai(?: language model| assistant)?`,
].join('|') + String.raw`)(?:[,!.:]+\s*|\s+(?=[a-z]))` +
  // "Certainly!", "Absolutely, ..." are filler only when punctuation follows: "Absolutely not" is an answer.
  String.raw`|(?:certainly|absolutely|of course)[,!]+\s*(?!not\b))`, 'gi');

export function toSpoken(text: string): string {
  let out = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    // "src/app/server.ts" -> "server.ts": a colleague says the file, not the path.
    .replace(/(?<![\w/])(?:\.{0,2}\/)?(?:[\w.-]+\/)+([\w-]+(?:\.[\w-]+)*\.[a-z0-9]{1,6})\b/gi, '$1')
    // "KAN-20" -> "KAN 20", so it is not read as "KAN minus twenty".
    .replace(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g, '$1 $2')
    // "recentCommits" -> "recent commits", "retry_worker" -> "retry worker".
    .replace(/\b([a-z]+)((?:[A-Z][a-z0-9]+)+)\b/g, (_m, head: string, rest: string) =>
      `${head} ${rest.replace(/([A-Z])/g, ' $1').trim().toLowerCase()}`)
    .replace(/\b([A-Za-z]+)_(?=[A-Za-z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  out = out.replace(ASSISTANT_OPENERS, '$1')
    // Announcer openers: "Short version:", "In short:", "TL;DR:".
    .replace(/(^|[.!?]\s+)(?:short version|long story short|in short|tl;?dr|the short answer is|bottom line)[:,]\s*/gi, '$1')
    // A plan's purpose clause: "I'll check the policy code to answer that accurately." -> "I'll check the policy code."
    .replace(/\s+(?:to|so (?:that )?I can|so I)\s+(?:answer|explain|walk you through|get|cover)\s+(?:that|this|it)(?:\s+right)?\s+(?:accurately|properly|correctly|precisely|right)(?=[.!?,])/gi, '')
    .replace(/\s+so (?:that )?I get (?:this|that|it) right(?=[.!?,])/gi, '')
    .replace(/\s+(?:so (?:that )?I can|to)\s+(?:give|get)\s+you\s+(?:an?\s+)?(?:accurate|proper|correct|precise|right|good)\s+answer(?=[.!?,])/gi, '')
    // Thinking out loud about the question: "This is a question about the team's code, so I'll check..." -> "I'll check...".
    .replace(/(^|[.!?]\s+)(?:this|that) (?:is|sounds like|looks like) a question (?:about|for|on) [^,.!?]{1,60},\s*(?:so\s+)?/gi, '$1');
  // A sentence that lost its opener starts with a capital again.
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, first: string) => lead + first.toUpperCase());
  return out.replace(/\s+/g, ' ').trim();
}

/** Picks a phrase that was not one of the last few she used, so a long meeting never hears a loop. */
export class PhrasePicker {
  private readonly recent: string[] = [];
  constructor(private readonly random: () => number = Math.random, private readonly memory = 3) {}
  pick(phrases: readonly string[]): string {
    const fresh = phrases.filter(phrase => !this.recent.includes(phrase));
    const pool = fresh.length ? fresh : phrases;
    const choice = pool[Math.floor(this.random() * pool.length) % pool.length]!;
    this.recent.push(choice);
    while (this.recent.length > this.memory) this.recent.shift();
    return choice;
  }
}
