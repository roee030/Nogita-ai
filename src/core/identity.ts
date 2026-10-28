export interface IdentityRecord {
  id: string;
  displayName: string;
  slack?: { teamId: string; userId: string };
  jiraAccountId?: string;
  githubUsername?: string;
  attendeeUserUuid?: string;
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid identity map: ${field} is required`);
  return value.trim();
}

export function parseIdentityRecords(raw: string): IdentityRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid identity map: expected JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('invalid identity map: expected an array');
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`invalid identity map: record ${index}`);
    const input = value as Record<string, unknown>;
    const record: IdentityRecord = {
      id: required(input.id, `record ${index} id`),
      displayName: required(input.displayName, `record ${index} displayName`),
    };
    if (input.slack !== undefined) {
      if (!input.slack || typeof input.slack !== 'object') throw new Error(`invalid identity map: record ${index} slack`);
      const slack = input.slack as Record<string, unknown>;
      record.slack = {
        teamId: required(slack.teamId, `record ${index} slack.teamId`),
        userId: required(slack.userId, `record ${index} slack.userId`),
      };
    }
    if (input.jiraAccountId !== undefined) record.jiraAccountId = required(input.jiraAccountId, `record ${index} jiraAccountId`);
    if (input.githubUsername !== undefined) record.githubUsername = required(input.githubUsername, `record ${index} githubUsername`);
    if (input.attendeeUserUuid !== undefined) record.attendeeUserUuid = required(input.attendeeUserUuid, `record ${index} attendeeUserUuid`);
    return record;
  });
}

export class IdentityDirectory {
  private readonly byId = new Map<string, IdentityRecord>();
  private readonly bySlack = new Map<string, IdentityRecord>();
  private readonly byJira = new Map<string, IdentityRecord>();
  private readonly byGitHub = new Map<string, IdentityRecord>();
  private readonly byAttendee = new Map<string, IdentityRecord>();

  constructor(records: readonly IdentityRecord[]) {
    for (const record of records) {
      if (this.byId.has(record.id)) throw new Error(`duplicate internal identity: ${record.id}`);
      this.byId.set(record.id, record);
      if (record.slack) {
        const key = `${record.slack.teamId}:${record.slack.userId}`;
        if (this.bySlack.has(key)) throw new Error(`duplicate Slack identity: ${key}`);
        this.bySlack.set(key, record);
      }
      if (record.jiraAccountId) {
        if (this.byJira.has(record.jiraAccountId)) throw new Error(`duplicate Jira identity: ${record.jiraAccountId}`);
        this.byJira.set(record.jiraAccountId, record);
      }
      if (record.githubUsername) {
        const key = record.githubUsername.toLowerCase();
        if (this.byGitHub.has(key)) throw new Error(`duplicate GitHub identity: ${record.githubUsername}`);
        this.byGitHub.set(key, record);
      }
      if (record.attendeeUserUuid) {
        if (this.byAttendee.has(record.attendeeUserUuid)) throw new Error(`duplicate Attendee identity: ${record.attendeeUserUuid}`);
        this.byAttendee.set(record.attendeeUserUuid, record);
      }
    }
  }

  fromSlack(teamId: string, userId: string): IdentityRecord | undefined {
    return this.bySlack.get(`${teamId}:${userId}`);
  }
  fromId(id: string): IdentityRecord | undefined { return this.byId.get(id); }
  fromJira(accountId: string): IdentityRecord | undefined { return this.byJira.get(accountId); }
  fromGitHub(username: string): IdentityRecord | undefined { return this.byGitHub.get(username.toLowerCase()); }
  fromAttendee(userUuid: string): IdentityRecord | undefined { return this.byAttendee.get(userUuid); }
  jiraAccountIdFor(id: string): string | undefined { return this.byId.get(id)?.jiraAccountId; }
  /** People with a board account whose display name is `name`, or whose first/last name is it. */
  findByName(name: string): Array<{ id: string; displayName: string }> {
    const wanted = name.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    if (!wanted) return [];
    const assignable = [...this.byId.values()].filter(record => record.jiraAccountId);
    const exact = assignable.filter(record => record.displayName.toLocaleLowerCase() === wanted);
    const matches = exact.length ? exact : assignable.filter(record =>
      record.displayName.toLocaleLowerCase().split(/\s+/).includes(wanted));
    return matches.map(record => ({ id: record.id, displayName: record.displayName }));
  }
  displayNameFor(id: string): string | undefined {
    const record = this.byId.get(id);
    return record?.jiraAccountId ? record.displayName : undefined;
  }
  hasAttendeeIdentity(): boolean { return this.byAttendee.size > 0; }
}
