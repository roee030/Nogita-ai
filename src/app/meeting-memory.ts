/**
 * Opt-in memory across meetings (NOGITA_MEETING_MEMORY=decisions): one small JSON file per meeting in
 * NOGITA_STATE_DIR/meetings with the decisions and action items people said plainly. Never the transcript, never audio.
 * Files older than the retention period are deleted on the next write.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingMemoryPort, MeetingRecord } from '../core/contracts.ts';

const NAME = /^(\d{13})-[0-9a-f]{8}\.json$/;
const MAX_FILES = 500;

export class FileMeetingMemory implements MeetingMemoryPort {
  private readonly directory: string;
  constructor(stateDirectory: string, private readonly retentionDays = 90, private readonly now = Date.now) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('meeting memory retention must be a positive number of days');
    this.directory = join(stateDirectory, 'meetings');
  }

  private async names(): Promise<string[]> {
    return (await readdir(this.directory).catch(() => [] as string[])).filter(name => NAME.test(name)).sort().reverse();
  }

  async remember(record: MeetingRecord): Promise<void> {
    if (!record.decisions.length && !record.actionItems.length) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${this.now()}-${randomUUID().slice(0, 8)}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    const oldest = this.now() - this.retentionDays * 86_400_000;
    const names = await this.names();
    await Promise.all(names.filter((name, index) => index >= MAX_FILES || Number(NAME.exec(name)![1]) < oldest)
      .map(name => rm(join(this.directory, name), { force: true })));
  }

  async search(words: string, limit = 5): Promise<MeetingRecord[]> {
    const terms = words.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 3);
    const found: MeetingRecord[] = [];
    for (const name of await this.names()) {
      let record: MeetingRecord;
      try { record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as MeetingRecord; } catch { continue; }
      const text = [...record.decisions, ...record.actionItems].map(item => item.text).join(' ').toLowerCase();
      if (!terms.length || terms.some(term => text.includes(term))) found.push(record);
      if (found.length >= limit) break;
    }
    return found;
  }
}
