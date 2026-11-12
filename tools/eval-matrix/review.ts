/**
 * P9-15 (partial): the synthetic matrix cases as a sheet a person can check line by line. For every line: the voice,
 * the topic, the statement type, which action it feeds, and whether its label is uncertain. For every action: owner,
 * date, confidence, source, and whether a write is allowed. The empty "OK?" column is for the reviewer.
 */
import type { Kind, MeetingCase } from './cases.ts';

const KIND_LABEL: Record<Kind, string> = {
  status: 'status update', decision: 'decision', blocker: 'blocker', proposal: 'proposal', question: 'open question',
  answer: 'answer / acceptance', backchannel: 'acknowledgement',
};
const cell = (value: string | null | undefined) => value === null || value === undefined ? '*not established*' : value.replace(/\|/g, '\\|');

export function renderReview(cases: readonly MeetingCase[]): string {
  const out: string[] = [
    '## How to review',
    '',
    'For each case, read the lines top to bottom and check, in the **OK?** column:',
    '1. **Voice:** S1–S4 are voices, not people. A name appears only where the call verified it.',
    '2. **Topic** and **statement type:** the type is what the line does, not how it sounds. "Maybe" or "I\'ll look into it" is a proposal, never a decision.',
    '3. **Uncertain:** these lines could honestly go either way. They are not scored; say if you would label them differently.',
    '4. **Actions:** the owner is set only when someone took the action. "*not established*" means the recap must leave it open.',
    '5. **Write allowed:** only items someone approved in the meeting. Everything else stays proposed.',
    '',
    'Write corrections in the PR or next to the row. Nothing here is approved until you say so.',
    '',
  ];
  for (const meeting of cases) {
    const feeds = new Map<string, number[]>();
    meeting.actions.forEach((a, i) => a.source.forEach(id => feeds.set(id, [...(feeds.get(id) ?? []), i + 1])));
    const names = Object.entries(meeting.speakers).map(([id, s]) => `${id}${s?.verifiedName ? ` (verified: ${s.verifiedName})` : ''}`);
    out.push(`## ${meeting.id}: ${meeting.title}`, '', `**Covers:** ${meeting.covers.join('; ')}.`, '',
      `**Voices:** ${names.join(', ')}. **Language:** ${meeting.language}. **Lines:** ${meeting.utterances.length}.`, '');
    out.push('| # | Time (s) | Voice | Line | Statement type | Topic | Talks over | Feeds action | Uncertain | OK? |',
      '|---|---|---|---|---|---|---|---|---|---|');
    for (const u of meeting.utterances) {
      out.push(`| ${u.id} | ${u.start}–${u.end} | ${u.speaker} | ${cell(u.text)} | ${KIND_LABEL[u.kind]} | ${u.topic} | ${u.overlaps?.join(', ') ?? ''} | ${feeds.get(u.id)?.map(n => `#${n}`).join(', ') ?? ''} | ${u.uncertain ? cell(u.uncertain) : ''} | |`);
    }
    out.push('', '**What the recap must say per topic**', '', '| Topic | Status | Decision | Blocker | Proposed next | Open question | OK? |', '|---|---|---|---|---|---|---|');
    for (const t of meeting.topics) out.push(`| ${t.id} ${cell(t.title)} | ${cell(t.status)} | ${cell(t.decision)} | ${cell(t.blocker)} | ${cell(t.proposedNext)} | ${cell(t.openQuestion)} | |`);
    if (meeting.links.length) {
      out.push('', '**Links between topics**', '', '| Link | Strength | Why | OK? |', '|---|---|---|---|');
      for (const l of meeting.links) out.push(`| ${l.from} → ${l.to} | ${l.strength} | ${cell(l.why)} | |`);
    }
    const approved = new Set(meeting.approval.approvedInMeeting);
    if (meeting.actions.length) {
      out.push('', '**Proposed actions** (numbered as the recap would show them)', '',
        '| # | Topic | Action | Owner | Due | Confidence | Source | Write allowed | OK? |', '|---|---|---|---|---|---|---|---|---|');
      meeting.actions.forEach((a, i) => {
        const owner = a.owner ?? (a.tentativeOwner ? `*not established* (${a.tentativeOwner} said maybe)` : '*not established*');
        out.push(`| ${i + 1} | ${a.topic} | ${cell(a.what)} | ${owner} | ${cell(a.due)} | ${a.confidence} | ${a.source.join(', ')} | ${approved.has(i + 1) ? '**yes**, approved' : 'no'} | |`);
      });
    } else out.push('', '**Proposed actions:** none.');
    out.push('', `**Writes:** ${approved.size ? [...approved].map(n => `#${n}`).join(', ') : 'none'}. ${meeting.approval.why}.`, '');
  }
  return out.join('\n');
}
