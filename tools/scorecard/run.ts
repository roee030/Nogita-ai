/**
 * The product test for one meeting (phase 8):
 *
 *   npm run scorecard -- --bot <attendee bot id> [--minutes 15] [--session meet-2026-11-03-2113] [--no-write]
 *
 * Reads Attendee's transcript and the meeting chat ("saved 15" there, or --minutes, is the minutes saved), finds the
 * Jira tasks she opened during the meeting (their Nogita request property marks them; the keys she said are checked
 * too, so a deleted one counts), reads their change history for a day after, and writes
 * docs/scorecards/<date>-<session>.md plus a row in docs/scorecards/README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { gatePassed, markdown, scorecard, tableRow, type Segment, type TaskHistory } from './score.ts';

const { values } = parseArgs({ options: { bot: { type: 'string' }, minutes: { type: 'string' }, session: { type: 'string' },
  'no-write': { type: 'boolean', default: false } } });
if (!values.bot) throw new Error('usage: npm run scorecard -- --bot <attendee bot id> [--minutes N]');
loadDotEnv();
const env = process.env as Record<string, string>;

async function attendee<T>(path: string): Promise<T> {
  const response = await fetch(`https://app.attendee.dev/api/v1/bots/${values.bot}${path}`, { headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}` } });
  if (!response.ok) throw new Error(`Attendee ${path || 'bot'}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const jiraAuth = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
async function jira(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, env.JIRA_BASE_URL), { ...init, headers: { Authorization: jiraAuth, Accept: 'application/json', 'Content-Type': 'application/json' } });
}

const bot = await attendee<{ metadata?: { session_id?: string }; events?: Array<{ type: string; created_at: string }> }>('');
const session = values.session ?? bot.metadata?.session_id ?? values.bot;
const joined = Date.parse(bot.events?.find(e => e.type === 'joined_meeting')?.created_at ?? '');
const left = Date.parse(bot.events?.find(e => e.type === 'left_meeting')?.created_at ?? '') || Date.now();
const transcript = await attendee<Array<{ speaker_name: string; timestamp_ms: number; duration_ms: number; transcription?: { transcript?: string } }>>('/transcript');
const segments: Segment[] = transcript.map(u => ({ speaker: u.speaker_name, start: u.timestamp_ms, end: u.timestamp_ms + (u.duration_ms ?? 0),
  text: u.transcription?.transcript ?? '', nogita: u.speaker_name === 'Nogita' }));
const chat = (await attendee<{ results?: Array<{ text?: string }> }>('/chat_messages')).results?.map(m => m.text ?? '') ?? [];

// Her tasks: created in the project while she was in the meeting and marked with her request property, plus any key
// she said aloud (a task deleted since then is a correction too).
const tasks: TaskHistory[] = [];
if (env.JIRA_BASE_URL && Number.isFinite(joined)) {
  // JQL dates are in the Jira user's own time zone.
  const zone = ((await (await jira('/rest/api/3/myself')).json()) as { timeZone?: string }).timeZone ?? 'UTC';
  const local = (ms: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).replace(/-/g, '/');
  const from = local(joined - 60_000);
  const to = local(left + 5 * 60_000);
  const found = await (await jira('/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify({
    jql: `project = ${env.JIRA_PROJECT_KEY} AND created >= "${from}" AND created <= "${to}"`, maxResults: 50, fields: ['created'] }) })).json() as
    { issues?: Array<{ key: string }> };
  const spoken = [...new Set(segments.filter(s => s.nogita).flatMap(s => [...s.text.matchAll(/\b([A-Z][A-Z0-9]+)[ -](\d+)\b/g)].map(m => `${m[1]}-${m[2]}`)))]
    .filter(key => key.startsWith(`${env.JIRA_PROJECT_KEY}-`));
  for (const key of [...new Set([...(found.issues ?? []).map(issue => issue.key), ...spoken])]) {
    const issue = await jira(`/rest/api/3/issue/${key}?fields=created&expand=changelog`);
    if (issue.status === 404) { if (spoken.includes(key)) tasks.push({ key, created: joined, deleted: true, changes: [] }); continue; }
    const mine = await jira(`/rest/api/3/issue/${key}/properties/com.nogita.request.v1`);
    if (!mine.ok) continue;
    const body = await issue.json() as { fields?: { created?: string }; changelog?: { histories?: Array<{ created: string; items?: Array<{ field: string }> }> } };
    tasks.push({ key, created: Date.parse(body.fields?.created ?? '') || joined,
      changes: (body.changelog?.histories ?? []).flatMap(h => (h.items ?? []).map(item => ({ at: Date.parse(h.created), field: item.field }))) });
  }
}

const date = new Date(Number.isFinite(joined) ? joined : Date.now()).toISOString().slice(0, 10);
const card = scorecard({ session, date, segments, tasks, chat, ...(values.minutes ? { minutesSaved: Number(values.minutes) } : {}) });
const text = markdown(card);
console.log(text);
if (!values['no-write']) {
  mkdirSync('docs/scorecards', { recursive: true });
  const file = `${date}-${session}.md`;
  writeFileSync(`docs/scorecards/${file}`, `${text}\n`);
  const index = 'docs/scorecards/README.md';
  const header = '# Meeting scorecards\n\nThe phase 8 product test (docs/WORK_PLAN.md). Gate: the last 5 meetings in a row pass.\n\n| Date | Meeting | Interruptions | Corrections | Minutes saved | Result |\n|---|---|---|---|---|---|\n';
  const current = existsSync(index) ? readFileSync(index, 'utf8') : header;
  const rows = current.split('\n').filter(line => /^\| \d{4}-/.test(line) && !line.includes(`[${session}]`));
  rows.push(tableRow(card, file));
  writeFileSync(index, `${header}${rows.join('\n')}\n\n**Gate (5 in a row): ${gatePassed(rows) ? 'passed' : 'not yet'}.**\n`);
  console.log(`\nWrote docs/scorecards/${file} and the row in ${index}`);
}
