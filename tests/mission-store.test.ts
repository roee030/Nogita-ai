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

    await new FileMissionStore(directory).save(openMission('M-HEALTHY'));
    const issues: string[] = [];
    const recovered = await new FileMissionStore(directory, async issue => {
      issues.push(issue.missionId ?? 'directory');
      throw new Error('chat unavailable');
    }).list();

    assert.deepEqual(recovered.map(mission => mission.id), ['M-HEALTHY']);
    assert.deepEqual(issues, ['M-BROKEN']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unreadable missions directory is reported while a missing one is a clean first start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    const issues: string[] = [];
    const store = new FileMissionStore(directory, issue => { issues.push(issue.reason); });
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(issues, []);

    await writeFile(join(directory, 'missions'), 'not a directory', 'utf8');
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(issues, ['directory_unreadable']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('valid JSON with no mission shape is reported as a lost snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    const missions = join(directory, 'missions');
    await mkdir(missions);
    await writeFile(join(missions, 'M-EMPTY.json'), '{}', 'utf8');
    const issues: string[] = [];

    assert.deepEqual(await new FileMissionStore(directory, issue => { issues.push(issue.missionId ?? 'directory'); }).list(), []);
    assert.deepEqual(issues, ['M-EMPTY']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a snapshot with malformed message elements is reported while its healthy sibling still loads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    await new FileMissionStore(directory).save(openMission('M-HEALTHY'));
    await writeFile(join(directory, 'missions', 'M-BADMSG.json'),
      JSON.stringify({ ...openMission('M-BADMSG'), messages: [null] }), 'utf8');
    const issues: string[] = [];

    const recovered = await new FileMissionStore(directory, issue => { issues.push(issue.missionId ?? 'directory'); }).list();

    assert.deepEqual(recovered.map(mission => mission.id), ['M-HEALTHY']);
    assert.deepEqual(issues, ['M-BADMSG']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a recovery reporter that never settles cannot block healthy missions', { timeout: 200 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-mission-store-'));
  try {
    await new FileMissionStore(directory).save(openMission('M-HEALTHY'));
    await writeFile(join(directory, 'missions', 'M-BROKEN.json'), '{', 'utf8');
    const never = new Promise<void>(() => undefined);

    const recovered = await new FileMissionStore(directory, () => never).list();

    assert.deepEqual(recovered.map(mission => mission.id), ['M-HEALTHY']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mission recovery issues are posted to the configured team chat', async () => {
  const posts: Array<{ channel: string; text: string }> = [];
  const report = FileMissionStore.reportToChat({
    postMessage: async (channel, text) => { posts.push({ channel, text }); return 'https://chat.test/1'; },
  }, 'mission-alerts');

  await report({ missionId: 'M-BROKEN', reason: 'snapshot_unreadable' });

  assert.deepEqual(posts, [{ channel: 'mission-alerts',
    text: 'Mission M-BROKEN could not be resumed after restart because its saved snapshot was unreadable. Its unfinished work may have been lost.' }]);
});
