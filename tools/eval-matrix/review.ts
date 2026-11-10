/**
 * P9-15 (partial): the synthetic matrix cases as a sheet a person can review line by line: transcript with speakers,
 * times, overlaps and expected kinds, then the expected recap per topic, the actions and what may be written.
 */
import type { MeetingCase } from './cases.ts';

const cell = (value: string | null | undefined) => value === null || value === undefined ? '*(not established)*' : value.replace(/\|/g, '\|');

export function renderReview(cases: readonly MeetingCase[]): string {
  const out: string[] = [];
  for (const meeting of cases) {
    out.push(`## ${meeting.id}: ${meeting.title}`, '', `**Covers:** ${meeting.covers.join('; ')}.`, '');
    const names = Object.entries(meeting.speakers).map(([id, s]) => `${id}${s?.verifiedName ? ` (verified: ${s.verifiedName})` : ''}`);
    out.push(`**Speakers:** ${names.join(', ')}. Labels are voices; a name appears only where the call verified it.`, '');
    out.push('| # | Time (s) | Voice | Line | Kind | Topic | Overlaps |', '|---|---|---|---|---|---|---|');
    for (const u of meeting.utterances) {
      out.push(`| ${u.id} | ${u.start}–${u.end} | ${u.speaker} | ${cell(u.text)} | ${u.kind} | ${u.topic} | ${u.overlaps?.join(', ') ?? ''} |`);
    }
    out.push('', '**Expected recap per topic**', '', '| Topic | Status | Decision | Blocker | Proposed next | Open question |', '|---|---|---|---|---|---|');
    for (const t of meeting.topics) out.push(`| ${t.id} ${cell(t.title)} | ${cell(t.status)} | ${cell(t.decision)} | ${cell(t.blocker)} | ${cell(t.proposedNext)} | ${cell(t.openQuestion)} |`);
    if (meeting.links.length) {
      out.push('', '**Links between topics**', '');
      for (const l of meeting.links) out.push(`- ${l.from} → ${l.to} (${l.strength}): ${l.why}`);
    }
    out.push('', '**Proposed actions** (numbered as the recap would show them)', '', '| # | Topic | Action | Owner | Due | Confidence | Source |', '|---|---|---|---|---|---|---|');
    meeting.actions.forEach((a, i) => out.push(`| ${i + 1} | ${a.topic} | ${cell(a.what)} | ${a.owner ?? (a.tentativeOwner ? `*(not confirmed; ${a.tentativeOwner} said maybe)*` : '*(not established)*')} | ${cell(a.due)} | ${a.confidence} | ${a.source.join(', ')} |`));
    const approved = meeting.approval.approvedInMeeting;
    out.push('', `**May be written:** ${approved.length ? approved.map(n => `#${n}`).join(', ') : 'nothing'}. ${meeting.approval.why}.`, '');
  }
  return out.join('\n');
}
