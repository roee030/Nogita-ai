import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GitHubCode } from '../src/adapters/github.ts';

interface Question { question: string; expectedPaths: string[]; answerable?: boolean }
const questions = JSON.parse(readFileSync(new URL('../tests/fixtures/repository-questions.json', import.meta.url), 'utf8')) as Question[];
const paths = execFileSync('git', ['ls-files', '--', 'src'], { encoding: 'utf8' }).trim().split(/\r?\n/)
  .filter(path => path.endsWith('.ts'));
const files = paths.map(path => ({ path, content: readFileSync(path),
  sha: createHash('sha1').update(path).digest('hex') }));
const bySha = new Map(files.map(file => [file.sha, file]));
const fakeFetch: typeof fetch = async url => {
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/commits/working-tree')) return new Response(JSON.stringify({
    sha: 'c'.repeat(40), commit: { tree: { sha: 'a'.repeat(40) } },
  }));
  if (path.includes('/git/trees/')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), tree: files.map(file => ({
    path: file.path.replace(/\\/g, '/'), type: 'blob', sha: file.sha, size: file.content.length,
  })) }));
  const file = bySha.get(path.split('/').at(-1) ?? '');
  if (file) return new Response(JSON.stringify({ encoding: 'base64', content: file.content.toString('base64') }));
  return new Response(null, { status: 404 });
};
const code = new GitHubCode({ token: 'evaluation-only', owner: 'example', repo: 'nogita', ref: 'working-tree' }, fakeFetch);
let hits = 0;
let targets = 0;
let unanswerableProbes = 0;
for (const item of questions) {
  const actualPaths = (await code.findEvidence(item.question)).map(item => item.path);
  if (item.answerable === false) {
    unanswerableProbes++;
    process.stdout.write(`unanswerable probe (${actualPaths.length} candidate files; answer quality not scored): ${item.question}\n`);
    continue;
  }
  const found = item.expectedPaths.filter(path => actualPaths.includes(path));
  hits += found.length;
  targets += item.expectedPaths.length;
  process.stdout.write(`${found.length}/${item.expectedPaths.length} ${item.question}\n`);
  if (found.length !== item.expectedPaths.length) process.stdout.write(`  expected: ${item.expectedPaths.join(', ')}\n  found: ${actualPaths.join(', ')}\n`);
}
process.stdout.write(`Retrieval recall@4: ${hits}/${targets} (${(100 * hits / targets).toFixed(1)}%)\n`);
process.stdout.write(`Unanswerable probes needing model-level review: ${unanswerableProbes}\n`);
