/**
 * The cell's state directory (queue, ledgers, missions, turn logs). A company's cell must keep it across restarts and
 * must never share it with another company, so it is checked and claimed before anything is written there.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MARKER = 'cell.json';

export class StateStorageError extends Error {
  override readonly name = 'StateStorageError';
  constructor(readonly kind: 'not_persistent' | 'not_writable' | 'other_company', message: string) { super(message); }
}

/**
 * Persistent storage is required for a company cell (one configured by NOGITA_TENANT_CONFIG) and when an operator asks
 * for it; a single-company setup from .env keeps working on a local folder, as before.
 */
export function persistentStateRequired(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NOGITA_TENANT_CONFIG?.trim()) || env.NOGITA_REQUIRE_PERSISTENT_STATE === 'true';
}

/** A state directory that survives a restart: an absolute mount path the operator confirmed is persistent. */
export function persistentStateConfigured(env: NodeJS.ProcessEnv): boolean {
  return env.NOGITA_STATE_PERSISTENT === 'true' && isAbsolute(env.NOGITA_STATE_DIR ?? '');
}

/**
 * Checks the directory can be written and records which company it belongs to. A directory that already belongs to
 * another company is refused. One written by a single-company setup ("default") is taken over once, so an existing
 * install can move to a company config without losing its state.
 */
export function claimStateDirectory(directory: string, tenantId: string, env: NodeJS.ProcessEnv,
  now = () => new Date()): { adopted: boolean } {
  if (persistentStateRequired(env) && !persistentStateConfigured(env)) {
    throw new StateStorageError('not_persistent', 'Persistent storage is required: mount a disk, set NOGITA_STATE_DIR to its absolute path, ' +
      'and set NOGITA_STATE_PERSISTENT=true after checking the mount.');
  }
  try {
    mkdirSync(directory, { recursive: true });
    const probe = join(directory, `.write-check-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch {
    throw new StateStorageError('not_writable', `The state directory cannot be written: ${directory}`);
  }
  const marker = join(directory, MARKER);
  let owner: string | undefined;
  try {
    owner = (JSON.parse(readFileSync(marker, 'utf8')) as { tenant?: unknown }).tenant as string | undefined;
  } catch { /* a new directory, or one from before cells were marked */ }
  if (owner === tenantId) return { adopted: false };
  if (owner && owner !== 'default') {
    throw new StateStorageError('other_company', `The state directory belongs to another company (${owner}); give ${tenantId} its own.`);
  }
  const temporary = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ tenant: tenantId, claimedAt: now().toISOString() })}\n`);
  renameSync(temporary, marker);
  return { adopted: owner === 'default' };
}
