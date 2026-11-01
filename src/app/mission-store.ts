/**
 * Missions on disk: one JSON file per mission in NOGITA_STATE_DIR/missions, replaced atomically (write, then rename),
 * so a crash never leaves half a mission and a restarted server resumes from the last saved step.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mission, MissionStore } from '../core/missions.ts';

export interface MissionRecoveryIssue {
  missionId: string;
  reason: 'snapshot_unreadable';
}

export class FileMissionStore implements MissionStore {
  private readonly directory: string;
  private ready?: Promise<void>;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(stateDirectory: string, private readonly reportRecoveryIssue?: (issue: MissionRecoveryIssue) => void) {
    this.directory = join(stateDirectory, 'missions');
  }

  async save(mission: Mission): Promise<void> {
    if (!/^M-[A-Z0-9]{1,20}$/.test(mission.id)) throw new Error('invalid mission id');
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
    if (!/^M-[A-Z0-9]{1,20}$/.test(id)) return undefined;
    try { return JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as Mission; }
    catch { return undefined; }
  }

  async list(): Promise<Mission[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const missions: Mission[] = [];
    for (const name of names.filter(n => /^M-[A-Z0-9]+\.json$/.test(n))) {
      const mission = await this.load(name.slice(0, -5));
      if (mission) missions.push(mission);
      else this.reportRecoveryIssue?.({ missionId: name.slice(0, -5), reason: 'snapshot_unreadable' });
    }
    return missions;
  }
}
