import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimStateDirectory, persistentStateRequired } from '../src/app/state-storage.ts';
import { buildReadinessReport } from '../src/app/readiness.ts';
import { IdentityDirectory } from '../src/core/identity.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'nogita-state-'));
const persistent = (directory: string) => ({ NOGITA_STATE_DIR: directory, NOGITA_STATE_PERSISTENT: 'true' });

test('state: a company cell needs persistent storage; a .env setup does not, unless asked', () => {
  assert.equal(persistentStateRequired({ NOGITA_TENANT_CONFIG: '/etc/nogita/acme.json' }), true);
  assert.equal(persistentStateRequired({ NOGITA_REQUIRE_PERSISTENT_STATE: 'true' }), true);
  assert.equal(persistentStateRequired({}), false);
  const directory = fresh();
  assert.throws(() => claimStateDirectory(directory, 'acme', { NOGITA_TENANT_CONFIG: 'x', NOGITA_STATE_DIR: directory }),
    (error: Error & { kind?: string }) => error.kind === 'not_persistent' && /NOGITA_STATE_PERSISTENT=true/.test(error.message));
  assert.throws(() => claimStateDirectory('relative', 'acme', { NOGITA_TENANT_CONFIG: 'x', NOGITA_STATE_DIR: 'relative',
    NOGITA_STATE_PERSISTENT: 'true' }), /absolute path/);
  assert.deepEqual(claimStateDirectory(directory, 'default', {}), { adopted: false });
});

test('state: the directory is marked with its company, and another company is refused', () => {
  const directory = fresh();
  const env = { NOGITA_TENANT_CONFIG: 'x', ...persistent(directory) };
  claimStateDirectory(directory, 'acme', env, () => new Date('2026-10-30T00:00:00Z'));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'cell.json'), 'utf8')), { tenant: 'acme', claimedAt: '2026-10-30T00:00:00.000Z' });
  assert.deepEqual(claimStateDirectory(directory, 'acme', env), { adopted: false });
  assert.throws(() => claimStateDirectory(directory, 'globex', env),
    (error: Error & { kind?: string }) => error.kind === 'other_company' && /belongs to another company \(acme\)/.test(error.message));
});

test('state: an existing single-company install moves to a company config without losing its state', () => {
  const directory = fresh();
  claimStateDirectory(directory, 'default', {});
  writeFileSync(join(directory, 'missions.json'), '[]');
  assert.deepEqual(claimStateDirectory(directory, 'acme', { NOGITA_TENANT_CONFIG: 'x', ...persistent(directory) }), { adopted: true });
  assert.throws(() => claimStateDirectory(directory, 'default', {}), /another company \(acme\)/);
});

test('readiness: a company cell without persistent storage is blocked, on Render or not', () => {
  const people = new IdentityDirectory([]);
  const queue = (env: NodeJS.ProcessEnv) => buildReadinessReport(env, people, '22.16.0').checks.find(item => item.id === 'durable_queue')!;
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.equal(queue({ NOGITA_QUEUE_ENCRYPTION_KEY: key }).status, 'ready');
  const cell = queue({ NOGITA_QUEUE_ENCRYPTION_KEY: key, NOGITA_TENANT_CONFIG: 'x' });
  assert.equal(cell.status, 'blocked');
  assert.match(cell.detail, /persistent storage/i);
  assert.equal(queue({ NOGITA_QUEUE_ENCRYPTION_KEY: key, NOGITA_TENANT_CONFIG: 'x', ...persistent('/var/lib/nogita') }).status, 'ready');
});
