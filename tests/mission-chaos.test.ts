import test from 'node:test';
import assert from 'node:assert/strict';
import { runChaos } from '../tools/mission-chaos/run.ts';

test('killed mid-mission and started again, missions write nothing twice and lose nothing without saying so', async () => {
  for (const seed of [1, 2]) {
    const result = await runChaos({ missions: 3, tasks: 3, kills: 6, seed });
    assert.ok(result.kills >= 2, `seed ${seed}: the process was killed ${result.kills} times`);
    assert.deepEqual(result.duplicates, [], `seed ${seed}`);
    assert.deepEqual(result.lostUnreported, [], `seed ${seed}`);
    assert.equal(result.writes, 9, `seed ${seed}`);
    assert.deepEqual(result.missions.map(m => m.status), ['done', 'done', 'done'], `seed ${seed}`);
  }
});

test('the check catches duplicates: a planner that retries blindly after a restart writes twice', async () => {
  const result = await runChaos({ missions: 3, tasks: 3, kills: 6, seed: 1, blind: true });
  assert.ok(result.duplicates.length > 0, 'expected duplicate writes from the blind planner');
  assert.ok(result.writes > 9);
});

test('a write cut off by a restart is reported as unknown, never as done, and resuming does not run it again', async () => {
  const { MemoryMissionStore, MissionRunner, missionReport } = await import('../src/core/missions.ts');
  const tool = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `${name}-1`, name, input });
  const model = (rounds: Array<Array<ReturnType<typeof tool>>>) => ({ agentModel: 'scripted', async streamChat() {
    const round = rounds.shift() ?? [tool('report_blocked', { reason: 'Need to check KAN first' })];
    return { content: round, stopReason: 'tool_use' as const };
  } });
  const store = new MemoryMissionStore();
  const runs: string[] = [];
  // The first process: the write is sent and the process dies before its result comes back.
  const hanging = { specs: [{ name: 'create_task', description: 'create_task', input_schema: { type: 'object' as const, properties: {} } }],
    isWrite: (name: string) => name === 'create_task',
    run: (name: string) => { runs.push(name); return new Promise<never>(() => undefined); } };
  const first = new MissionRunner({ model: model([[tool('create_task', { title: 'Cache headers' })]]), store, toolbox: () => hanging, newId: () => 'M-K1' });
  const mission = await first.start({ goal: 'Open a task for the cache headers', owner: { id: 'roee', displayName: 'Roee' } });
  await first.idle();
  void first.approve(mission.id, 'roee');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(runs, ['create_task']);

  // The next process resumes from the store; its planner blocks instead of retrying.
  const second = new MissionRunner({ model: model([]), store, toolbox: () => hanging, newId: () => 'unused' });
  await second.resumeAll();
  await second.idle();
  const report = missionReport(second.get(mission.id)!);
  assert.deepEqual(runs, ['create_task'], 'resuming ran the write again');
  assert.deepEqual(report.unknown, ['create the task "Cache headers"']);
  assert.deepEqual(report.done, []);
  assert.ok(!report.failed.some(line => /Cache headers/.test(line)));
});
