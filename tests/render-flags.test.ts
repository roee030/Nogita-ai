import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('config/render-flags.env holds only known on/off flags, so no secret or misspelled name gets in', () => {
  const known = readFileSync('.env.example', 'utf8');
  const lines = readFileSync('config/render-flags.env', 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const [name, value] = line.split('=');
    assert.equal(value, 'true', line);
    assert.match(known, new RegExp(`^${name}=`, 'm'), `${name} is not in .env.example`);
  }
});
