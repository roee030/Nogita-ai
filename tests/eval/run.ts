/**
 * The eval set against the real model: every case runs through the engine and agent loop with Anthropic, against the
 * in-memory GitHub, Jira and Slack in world.ts, and is scored on accuracy, completeness, sources, clarity and
 * avoiding fabrication. Nothing outside this process is written.
 *
 *   npm run eval                          all cases once
 *   npm run eval -- --case live-repo-today --repeat 5
 *   npm run eval -- --json out.json       also write every run and score
 *
 * Needs ANTHROPIC_API_KEY (from .env or the environment); ANTHROPIC_AGENT_MODEL picks the model as in production.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../../src/adapters/anthropic.ts';
import { CASES, DIMENSIONS } from './cases.ts';
import { runCase, scoreCase, summarize, type CaseScore } from './harness.ts';

const { values } = parseArgs({ options: {
  case: { type: 'string', multiple: true }, repeat: { type: 'string', default: '1' }, json: { type: 'string' },
} });
loadDotEnv();
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  process.stderr.write('Set ANTHROPIC_API_KEY (in .env or the environment) to run the eval set.\n');
  process.exit(2);
}
const repeat = Math.max(1, Number(values.repeat) || 1);
const cases = values.case?.length ? CASES.filter(item => values.case!.includes(item.id)) : CASES;
if (!cases.length) {
  process.stderr.write(`No such case. Cases: ${CASES.map(item => item.id).join(', ')}\n`);
  process.exit(2);
}
const model = new AnthropicBrain(key, process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, fetch, {}, {},
  { model: process.env.ANTHROPIC_AGENT_MODEL, thinking: process.env.ANTHROPIC_AGENT_THINKING === 'on' ? 'default' : 'off' });
process.stdout.write(`Eval: ${cases.length} case(s) x ${repeat} on ${model.agentModel}\n\n`);

const scores: CaseScore[] = [];
const runs: unknown[] = [];
for (const item of cases) {
  for (let attempt = 0; attempt < repeat; attempt++) {
    const run = await runCase(model, item);
    const score = scoreCase(item, run);
    scores.push(score);
    runs.push({ id: item.id, turns: run.turns, tools: run.tools, stops: run.stops, writes: run.calls.filter(call =>
      ['createTask', 'updateTask', 'postMessage', 'openDraft'].includes(call.method)), ms: run.ms, error: run.error, score });
    const failed = score.checks.filter(check => !check.pass);
    process.stdout.write(`${score.passed ? 'PASS' : 'FAIL'} ${item.id}${repeat > 1 ? ` #${attempt + 1}` : ''} (${(run.ms / 1000).toFixed(1)} s, ` +
      `${run.tools.length ? run.tools.join(' ') : 'no tools'}; stops ${run.stops.join(' ')})\n`);
    for (const check of failed) process.stdout.write(`     x ${check.dimension}: ${check.name}\n`);
    if (!score.passed) {
      const last = run.turns.at(-1);
      if (run.error) process.stdout.write(`     error: ${run.error}\n`);
      if (last) process.stdout.write(`     said: ${[...last.spoken, ...last.chat].join(' | ').replace(/\s+/g, ' ').slice(0, 400)}\n`);
    }
  }
}
const summary = summarize(scores);
process.stdout.write(`\n${summary.passed}/${summary.cases} runs passed every check\n`);
for (const dimension of DIMENSIONS) {
  const { passed, total, score } = summary.dimensions[dimension];
  process.stdout.write(`  ${dimension.padEnd(15)} ${(100 * score).toFixed(0).padStart(3)}%  (${passed}/${total})\n`);
}
if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ model: model.agentModel, at: new Date().toISOString(), summary, runs }, null, 1)}\n`);
  process.stdout.write(`wrote ${values.json}\n`);
}
