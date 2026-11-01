/**
 * Missions on disk: one JSON file per mission in NOGITA_STATE_DIR/missions, replaced atomically (write, then rename),
 * so a crash never leaves half a mission and a restarted server resumes from the last saved step.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mission, MissionStore } from '../core/missions.ts';

export interface MissionRecoveryIssue {
  missionId?: string;
  reason: 'snapshot_unreadable' | 'directory_unreadable';
}

type RecoveryReporter = (issue: MissionRecoveryIssue) => Promise<void> | void;

const MISSION_ID = /^M-[A-Z0-9]{1,20}$/;
const MISSION_STATUSES = new Set(['investigating', 'executing', 'awaiting_approval', 'blocked', 'done', 'failed', 'cancelled']);
const STEP_KINDS = new Set(['started', 'tool', 'finding', 'approval_requested', 'approved', 'rejected', 'write_started',
  'write_done', 'verification_failed', 'finished', 'blocked', 'error', 'resumed', 'cancelled']);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isContent(value: unknown): boolean {
  if (!record(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'tool_use') return typeof value.id === 'string' && typeof value.name === 'string' && record(value.input);
  return value.type === 'tool_result' && typeof value.tool_use_id === 'string' && typeof value.content === 'string' &&
    (value.is_error === undefined || typeof value.is_error === 'boolean');
}

function isMessage(value: unknown): boolean {
  return record(value) && (value.role === 'user' || value.role === 'assistant') &&
    (typeof value.content === 'string' || (Array.isArray(value.content) && value.content.every(isContent)));
}

function isStep(value: unknown): boolean {
  return record(value) && typeof value.at === 'number' && typeof value.kind === 'string' && STEP_KINDS.has(value.kind) &&
    typeof value.text === 'string' && (value.tool === undefined || typeof value.tool === 'string') &&
    (value.ok === undefined || typeof value.ok === 'boolean');
}

function isMission(value: unknown, id: string): value is Mission {
  if (!value || typeof value !== 'object') return false;
  const mission = value as Partial<Mission>;
  return mission.id === id && typeof mission.goal === 'string' && typeof mission.doneWhen === 'string' &&
    Boolean(mission.owner && typeof mission.owner.id === 'string' && typeof mission.owner.displayName === 'string') &&
    typeof mission.status === 'string' && MISSION_STATUSES.has(mission.status) &&
    typeof mission.createdAt === 'number' && typeof mission.updatedAt === 'number' &&
    typeof mission.attempts === 'number' && typeof mission.rounds === 'number' &&
    Array.isArray(mission.steps) && mission.steps.every(isStep) &&
    Array.isArray(mission.messages) && mission.messages.every(isMessage);
}

export class FileMissionStore implements MissionStore {
  private readonly directory: string;
  private ready?: Promise<void>;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(stateDirectory: string, private readonly reportRecoveryIssue?: RecoveryReporter) {
    this.directory = join(stateDirectory, 'missions');
  }

  /** Formats recovery failures once; the server only supplies its configured team-chat destination. */
  static reportToChat(chat: { postMessage(channel: string, text: string): Promise<unknown> } | undefined, channel: string | undefined,
    log: (event: string, detail: string) => void = console.error): RecoveryReporter {
    return async issue => {
      const subject = issue.missionId ? `Mission ${issue.missionId}` : 'The mission store';
      const detail = issue.reason === 'snapshot_unreadable'
        ? `${subject} could not be resumed after restart because its saved snapshot was unreadable. Its unfinished work may have been lost.`
        : `${subject} could not be read after restart. Open missions may not have resumed.`;
      if (chat && channel) await chat.postMessage(channel, detail);
      else log('mission_recovery_issue', detail);
    };
  }

  private async report(issue: MissionRecoveryIssue): Promise<void> {
    try { await this.reportRecoveryIssue?.(issue); }
    catch { console.error('mission_recovery_report_failed', issue.missionId ?? issue.reason); }
  }

  async save(mission: Mission): Promise<void> {
    if (!MISSION_ID.test(mission.id)) throw new Error('invalid mission id');
    const snapshot = JSON.stringify(mission);
    // Saves of one mission are serialized, so an older snapshot never lands after a newer one.
    const previous = this.writes.get(mission.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.ready;
      const file = join(this.directory, `${mission.id}.json`);
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    });
    this.writes.set(mission.id, next);
    await next;
  }

  async load(id: string): Promise<Mission | undefined> {
    if (!MISSION_ID.test(id)) return undefined;
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
      return isMission(value, id) ? value : undefined;
    }
    catch { return undefined; }
  }

  async list(): Promise<Mission[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      void this.report({ reason: 'directory_unreadable' });
      return [];
    }
    const missions: Mission[] = [];
    for (const name of names.filter(n => MISSION_ID.test(n.slice(0, -5)) && n.endsWith('.json'))) {
      const mission = await this.load(name.slice(0, -5));
      if (mission) missions.push(mission);
      else void this.report({ missionId: name.slice(0, -5), reason: 'snapshot_unreadable' });
    }
    return missions;
  }
}
