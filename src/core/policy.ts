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

/** Prevent simple third-person name mentions from activating the bot. */
export function directlyAddressesNogita(text: string): boolean {
  const s = text.trim();
  return /^(?:(?:hey|hi|hello|okay|ok|please|excuse me|thanks|thank you)\s+)?nogita\b[\s,.:!?-]*/i.test(s)
    || /\b(?:can you|could you|would you|what do you think|how about you),?\s+nogita[?!.]?$/i.test(s);
}
export function removeAddress(text: string): string {
  return text.replace(/^(?:(?:hey|hi|hello|okay|ok|please|excuse me|thanks|thank you)\s+)?nogita\b[\s,.:!?-]*/i, '').trim();
}
