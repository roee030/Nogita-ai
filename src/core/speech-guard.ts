/**
 * Everything the voice agent writes is spoken. With thinking off, a model sometimes thinks in its reply instead
 * ("Avi is addressing Roy, not me, so I'll stay quiet", measured in the voice lab after the prompt already forbade
 * it). The prompt asks; this guard enforces: deliberation about who is addressed, whether to reply, or what the
 * lookup showed never reaches the meeting. The patterns are narrow on purpose: dropping a real answer is worse
 * than letting an odd sentence through, so each one needs a self-reference ("me", "so I'll answer") to match.
 */
const DELIBERATION: readonly RegExp[] = [
  // Who the words were for.
  /\b(?:not|isn't|wasn't|aren't|weren't)\s+(?:addressed|directed|meant|aimed)\s+(?:to|at|for)\s+me\b/i,
  /\b(?:addressing|talking to|asking|speaking to)\s+[\p{L}'-]+,?\s+not\s+me\b/iu,
  /\b(?:addressed|directed|aimed)\s+(?:to|at)\s+me\b/i,
  /\bdirect question (?:to|for) me\b/i,
  /\bmeant for (?!me\b)[\p{Lu}][\p{L}'-]*/u,
  // Whether to reply at all.
  /\bempty (?:reply|message|response|answer)\b/i,
  /\bstay(?:ing)? (?:quiet|silent|out of (?:this|it|that))\b/i,
  /\bso I(?:'ll| will| should| need to)\s+(?:answer|respond|reply|skip|ignore|stay)\b/i,
  // Planning the lookup out loud ("..., so I need to see where it's set").
  /\bso I (?:need|have|want) to (?:see|check|look|find out|confirm|verify|figure out)\b/i,
  // Classifying the request out loud.
  /^(?:this|that)\s+(?:is\s+(?:a|an)\s+)?(?:follow-up|message|question|request|utterance)\b(?=.*\b(?:me|so I)\b)/i,
  // Talking about the speaker instead of to them (live Meet: "All the is garbled, and I can't tell what tasks he
  // wants. Ask him once briefly,").
  /\bcan't tell what\b.*\b(?:he|she)\s+(?:wants|means|is asking|meant|said)\b/i,
  /\b(?:is|was|sounds) garbled\b/i,
  /^ask (?:him|her) (?:once|briefly|again|what|which|to)\b/i,
  // Auditing her own earlier answer aloud ("My last answer wasn't backed by a lookup I actually ran").
  /\bbacked by (?:a|any|the) (?:lookup|tool)\b/i,
  // Reasoning over tool output instead of answering from it.
  /\b(?:search hits|tool results?)\b/i,
  /\bbefore (?:naming|answering|I answer|giving (?:an|the) answer|replying)\b/i,
];

export function isReasoningAloud(sentence: string): boolean {
  const text = sentence.trim();
  return !!text && DELIBERATION.some(pattern => pattern.test(text));
}

/** Drops deliberation sentences and keeps everything else as written; empty when nothing was meant for the room. */
export function stripReasoningAloud(text: string): string {
  return text.split(/(?<=[.!?])\s+/).filter(sentence => !isReasoningAloud(sentence)).join(' ').trim();
}

/** "Nogita speaks only when..." said by Nogita. A lab tell (the prompt fixes it); never used to drop speech. */
export function refersToSelfInThirdPerson(text: string): boolean {
  return /\bNogita\s+(?:speaks|answers|responds|replies|only|is|does|will|can|listens|waits|stays|joins|raises|decides)\b/.test(text);
}
