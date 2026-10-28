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

export function isRepositoryConnectionQuestion(current: string): boolean {
  return /\b(?:connected|connect|access)\b.{0,50}\b(?:repo|repository|github)\b/i.test(current)
    || /\b(?:repo|repository|github)\b.{0,50}\b(?:connected|connect|access)\b/i.test(current);
}

/** A fast hint for evidence retrieval. Ambiguous questions can still use the planner's inspect_code action. */
export function isRepositoryQuestion(current: string): boolean {
  return /\b(?:repo|repository|github|code|source|implementation|function|module|file|commit|push(?:ed)?|branch|merge|pull request|authentication|authorization|login|log-in|sign-in|webhook|endpoint|provider|configuration|database|deployment|architecture)\b/i.test(current);
}

export function isExplicitLeaveRequest(current: string): boolean {
  const text = current.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (current.trim().endsWith('?') && !/^(?:please\s+)?(?:can you|could you|would you)\s+/.test(text)) return false;
  return /^(?:(?:please|you can|can you|could you|would you)\s+)*(?:leave|exit|disconnect)(?:\s+(?:this|the)\s+(?:call|meeting))?(?:\s+(?:now|please))?$/.test(text)
    || /^(?:(?:please|you can|can you|could you|would you)\s+)*(?:drop|end)\s+(?:this|the)\s+(?:call|meeting)(?:\s+(?:now|please))?$/.test(text);
}

const initialAddress = /^(?:(?:hey|hi|hello|okay|ok|please|excuse me|thanks|thank you)\s+)?nogita(?:\s*[,.:!?-]\s*|\s+(?=what\b|why\b|where\b|when\b|who\b|how\b|can\b|could\b|would\b|will\b|please\b|tell\b|explain\b|show\b|say\b|do\b|check\b|help\b|drop\b|leave\b|exit\b|end\b|verify\b|hello\b|hi\b|i\b|you\b|we\b))/i;
const laterAddress = /[.!?;]\s+(?:(?:hey|hi|hello|okay|ok|please)\s+)?nogita(?:\s*[,.:!?-]\s*|\s+(?=what\b|why\b|where\b|when\b|who\b|how\b|can\b|could\b|would\b|will\b|please\b|tell\b|explain\b|show\b|say\b|do\b|check\b|help\b|drop\b|leave\b|exit\b|end\b|verify\b|hello\b|hi\b|i\b|you\b|we\b))/i;

/** Prevent simple third-person name mentions from activating the bot. */
export function directlyAddressesNogita(text: string): boolean {
  const s = text.trim();
  return initialAddress.test(s)
    || laterAddress.test(s)
    || /^(?:how are you|are you|can you|could you|would you|what do you think|how about you),?\s+nogita\b/i.test(s)
    || /\b(?:can you|could you|would you|what do you think|how about you),?\s+nogita[?!.]?$/i.test(s);
}
export function removeAddress(text: string): string {
  if (initialAddress.test(text)) return text.replace(initialAddress, '').trim();
  if (laterAddress.test(text)) return text.slice(text.search(laterAddress)).replace(laterAddress, '').trim();
  return text.replace(/,?\s*nogita\s*,?/i, ' ').replace(/\s+([?!.])/g, '$1').replace(/\s+/g, ' ').trim();
}
