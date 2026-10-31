import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('GET /version exposes the Render deployment commit without authentication', async () => {
  const port = await freePort();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'nogita-version-'));
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-transform-types',
    'src/app/server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NOGITA_ADMIN_TOKEN: 'test-admin-token-with-more-than-32-characters',
      NOGITA_MODE: 'demo',
      BOARD_PROVIDER: 'demo',
      REPO_PROVIDER: 'demo',
      NOGITA_STATE_DIR: stateDirectory,
      RENDER_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${stderr}`)), 10_000);
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`server exited with ${code}: ${stderr}`));
      });
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('Nogita dev server listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/version`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sha: '0123456789abcdef0123456789abcdef01234567' });
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
