/**
 * Live research gate against the configured GitHub repository and the local checkout's git history.
 *
 *   npm run research-bench
 *   npm run research-bench -- today
 *   node --experimental-transform-types tools/research-bench/run.ts --period today --branch origin/main --json research-bench.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDotEnv, createDependencies } from '../../src/app/config.ts';
import { buildToolbox } from '../../src/core/agent-tools.ts';
import { assertRepositoryMatches, formatResearchReport, gitRefToBranch, readGitGroundTruth, runResearchScenario,
  type ResearchPeriod } from './index.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  period: { type: 'string', multiple: true },
  branch: { type: 'string', default: 'origin/main' },
  json: { type: 'string' },
} });
const validPeriods = new Set<ResearchPeriod>(['today', 'this_week']);
const periods = (values.period?.length ? values.period : positionals.length ? positionals : ['today', 'this_week']) as ResearchPeriod[];
if (periods.some(period => !validPeriods.has(period))) {
  process.stderr.write('Periods are today and this_week.\n');
  process.exit(2);
}

loadDotEnv();
const dependencies = createDependencies(process.env);
if (!dependencies.agent) throw new Error('Set NOGITA_MODE=live, NOGITA_AGENT=on and ANTHROPIC_API_KEY to run the research benchmark');
if (!dependencies.code.repoActivity) throw new Error('Configure a GitHub repository with repo_activity support');
const actorId = dependencies.connections.authorizedActorIds[0];
if (!actorId) throw new Error('Configure at least one AUTHORIZED_ACTOR_IDS entry for the benchmark');
const actor = { id: actorId, displayName: dependencies.identities.fromId(actorId)?.displayName ?? 'Research benchmark', verified: true };
const team = { timeZone: dependencies.tenant.timeZone ?? 'UTC', weekStartsOn: dependencies.tenant.weekStartsOn ?? 'monday' } as const;

if (dependencies.code.prepare) await dependencies.code.prepare();
const benchmarkNow = Date.now();
const nowIso = new Date(benchmarkNow).toISOString();
const liveBranch = gitRefToBranch(values.branch!);
const runs = [];
for (const period of periods) {
  const truth = await readGitGroundTruth(period, { branch: values.branch!, team, now: benchmarkNow });
  const liveActivity = await dependencies.code.repoActivity({ since: truth.since, until: truth.until, branch: liveBranch });
  assertRepositoryMatches(truth.remoteUrl, liveActivity.repository, liveBranch, liveActivity.branch);
  const request = `Nogita, what landed in the repository on branch ${liveBranch} ${period === 'today' ? 'today' : 'this week'}? ` +
    'Include every commit with its short SHA and every merged pull request with its PR number.';
  const { toolbox } = buildToolbox({ actor, request, sessionId: 'research-bench', eventId: `research-${period}`,
    policy: dependencies.policy, code: dependencies.code, board: dependencies.board, chat: dependencies.chat,
    people: dependencies.people, drafts: undefined, completed: new Map(), onReceipt: async () => {}, team,
    now: () => benchmarkNow });
  const result = await runResearchScenario({ period, groundTruth: truth, branch: liveBranch,
    model: dependencies.agent, toolbox, team, nowIso });
  runs.push({ truth, result });
  process.stdout.write(`${formatResearchReport(result, truth)}\n`);
}

if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ model: dependencies.agent.agentModel, at: new Date().toISOString(), runs }, null, 2)}\n`);
  process.stdout.write(`wrote ${values.json}\n`);
}
if (runs.some(run => !run.result.coverage.passed)) process.exitCode = 1;
