/**
 * Records the repository history the eval's fake GitHub serves: every commit on main from 30 October 2026 (team
 * time) up to a fixed sha, with per-file +/- counts, and the pull requests merged in that range. Run it again only
 * to move the frozen point; the cases' expectations are written against fixtures/history.json.
 *
 *   node --experimental-transform-types tests/eval/record-history.ts [sha]
 *
 * Needs git and an authenticated gh.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { EvalHistory } from './world.ts';

const HEAD = process.argv[2] ?? 'c6b95a5';
const SINCE = '2026-10-29T22:00:00Z';
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

function numstat(args: string[]): EvalHistory['commits'][number]['files'] {
  return run('git', [...args, '--numstat', '--format=']).split(/\r?\n/).filter(Boolean).map(line => {
    const [added, deleted, path] = line.split('\t') as [string, string, string];
    return { path, status: 'modified', additions: Number(added) || 0, deletions: Number(deleted) || 0 };
  });
}

const head = run('git', ['rev-parse', HEAD]);
const commits = run('git', ['log', head, `--since=${SINCE}`, '--format=%H%x09%aI%x09%an%x09%P%x09%s']).split(/\r?\n/)
  .filter(Boolean).map(line => {
    const [sha, date, author, parents, title] = line.split('\t') as [string, string, string, string, string];
    const merge = parents.split(' ').length > 1;
    return { sha, date: new Date(date).toISOString(), author, title, merge,
      files: merge ? [] : numstat(['show', sha]) };
  });
const inRange = new Set(commits.map(commit => commit.sha));
const pulls = (JSON.parse(run('gh', ['pr', 'list', '--state', 'merged', '--limit', '100', '--json',
  'number,title,body,author,mergedAt,mergeCommit'])) as Array<{ number: number; title: string; body: string;
  author: { login: string }; mergedAt: string; mergeCommit: { oid: string } }>)
  .filter(pull => inRange.has(pull.mergeCommit.oid))
  .map(pull => ({ number: pull.number, title: pull.title, body: pull.body.slice(0, 1500), author: pull.author.login,
    mergedAt: pull.mergedAt, mergeCommit: pull.mergeCommit.oid,
    files: numstat(['diff', `${pull.mergeCommit.oid}^1`, pull.mergeCommit.oid]) }))
  .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));

const history: EvalHistory = { repository: 'roee030/Nogita-ai', branch: 'main', head, commits, pullRequests: pulls };
writeFileSync(new URL('./fixtures/history.json', import.meta.url), `${JSON.stringify(history, null, 1)}\n`);
process.stdout.write(`${commits.length} commits, ${pulls.length} merged pull requests up to ${head.slice(0, 7)}\n`);
