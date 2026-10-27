import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('repository pins a supported Node runtime and verifies every pull request', () => {
  assert.equal(readFileSync('.node-version', 'utf8').trim(), '22.16.0');
  const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run typecheck/);
  const externalActions = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)]
    .map(match => match[1]!)
    .filter(reference => !reference.startsWith('./'));
  assert.ok(externalActions.length > 0);
  for (const reference of externalActions) assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/);
});

test('local secrets and runtime state are excluded from source control', () => {
  const ignore = readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^\.nogita-state\/$/m);
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const sensitive = tracked.filter(path => {
    const parts = path.split('/');
    const basename = parts.at(-1)!;
    return (basename !== '.env.example' && (basename === '.env' || basename.startsWith('.env.'))) ||
      parts.includes('.nogita-state');
  });
  assert.deepEqual(sensitive, []);
});

test('production container is non-root, health-checked, secret-safe, and built in CI', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const dockerignore = readFileSync('.dockerignore', 'utf8');
  const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');
  assert.match(dockerfile, /^FROM node:22\.16\.0-bookworm-slim/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
  for (const entry of ['.env', '.env.*', '.nogita-state', '.git', 'node_modules']) {
    assert.ok(dockerignore.split(/\r?\n/).includes(entry), `missing ${entry} from .dockerignore`);
  }
  assert.match(workflow, /docker build --pull=false --tag nogita-ci:\$\{\{ github\.sha \}\} \./);
});
