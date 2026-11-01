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
