/** The team's calendar: "today", "yesterday" and "this week" in the team's time zone, as UTC instants. */

export interface TeamTime {
  /** IANA name, for example "Asia/Jerusalem". */
  timeZone: string;
  weekStartsOn: 'sunday' | 'monday';
}

export type TeamPeriod = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'last_7_days';
export const TEAM_PERIODS: readonly TeamPeriod[] = ['today', 'yesterday', 'this_week', 'last_week', 'last_7_days'];
export const UTC_TEAM: TeamTime = { timeZone: 'UTC', weekStartsOn: 'monday' };

const DAY_MS = 86_400_000;

export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

/** Local calendar fields of an instant in a time zone. */
function localParts(ms: number, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** The zone's offset from UTC at an instant, in ms (local minus UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The UTC instant of local midnight on the given local date. Checked twice so a DST change that day lands right. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - offsetAt(wall, timeZone);
  guess = wall - offsetAt(guess, timeZone);
  return guess;
}

/** Start of the local day `daysBack` days before the day containing `nowMs`. */
function dayStart(nowMs: number, daysBack: number, timeZone: string): number {
  const today = localParts(nowMs, timeZone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day) - daysBack * DAY_MS);
  return localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
}

/** A named period as [since, until) UTC ISO instants; until is now for periods that are still running. */
export function teamPeriod(period: TeamPeriod, nowMs: number, team: TeamTime): { since: string; until: string } {
  const iso = (ms: number) => new Date(ms).toISOString();
  const { timeZone } = team;
  const weekday = localParts(nowMs, timeZone).weekday;
  const intoWeek = (weekday - (team.weekStartsOn === 'sunday' ? 0 : 1) + 7) % 7;
  switch (period) {
    case 'today': return { since: iso(dayStart(nowMs, 0, timeZone)), until: iso(nowMs) };
    case 'yesterday': return { since: iso(dayStart(nowMs, 1, timeZone)), until: iso(dayStart(nowMs, 0, timeZone)) };
    case 'this_week': return { since: iso(dayStart(nowMs, intoWeek, timeZone)), until: iso(nowMs) };
    case 'last_week': return { since: iso(dayStart(nowMs, intoWeek + 7, timeZone)), until: iso(dayStart(nowMs, intoWeek, timeZone)) };
    case 'last_7_days': return { since: iso(nowMs - 7 * DAY_MS), until: iso(nowMs) };
  }
}

/** One line for the turn prompt: the team's local date and time, so relative dates mean the team's days. */
export function describeTeamTime(nowMs: number, team: TeamTime): string {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: team.timeZone, weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs));
  return `The team's time zone is ${team.timeZone}; it is ${local} there. "Today", "yesterday" and "this week" mean the team's local days (weeks start on ${team.weekStartsOn === 'sunday' ? 'Sunday' : 'Monday'}).`;
}
