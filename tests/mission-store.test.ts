import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMissionStore } from '../src/app/mission-store.ts';
import { claimStateDirectory } from '../src/app/state-storage.ts';
import type { Mission } from '../src/core/missions.ts';

function openMission(id = 'M-RESTART'): Mission {
  return {
    id,
    goal: 'Check KAN-20',
    doneWhen: 'The blocking task is identified.',
    owner: { id: 'roee', displayName: 'Roee' },
    sessionId: 'meeting-1',
    status: 'investigating',
    createdAt: 1,
    updatedAt: 2,
    attempts: 0,
    rounds: 1,
    steps: [{ at: 1, kind: 'started', text: 'Delegated by Roee: Check KAN-20' }],
    messages: [{ role: 'user', content: 'Mission from Roee: Check KAN-20' }],
  };
}

test('an open mission survives a local restart without requiring a persistent-disk flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    assert.deepEqual(claimStateDirectory(directory, 'default', {}), { adopted: false });
    await new FileMissionStore(directory).save(openMission());

    const afterRestart = await new FileMissionStore(directory).list();

    assert.equal(afterRestart.length, 1);
    assert.deepEqual(afterRestart[0], openMission());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a damaged mission snapshot is reported by id instead of disappearing from restart recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    const missions = join(directory, 'missions');
    await mkdir(missions);
    await writeFile(join(missions, 'M-BROKEN.json'), '{"id":"M-BROKEN",', 'utf8');

    const issues: string[] = [];
    const recovered = await new FileMissionStore(directory, issue => issues.push(issue.missionId)).list();

    assert.deepEqual(recovered, []);
    assert.deepEqual(issues, ['M-BROKEN']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
