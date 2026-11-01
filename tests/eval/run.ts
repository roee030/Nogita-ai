/**
 * The eval set against the real model: every case runs through the engine and agent loop with Anthropic, against the
 * in-memory GitHub, Jira and Slack in world.ts, and is scored on accuracy, completeness, sources, clarity and
 * avoiding fabrication. Nothing outside this process is written.
 *
 *   npm run eval                          all cases once
 *   npm run eval -- --case live-repo-today --repeat 5
 *   npm run eval -- --group missions      one group of cases
 *   npm run eval -- --json out.json       write every run and score there (default: .eval/<time>.json, which
 *                                         npm run dashboard reads for the trend); --no-json writes nothing
 *   npm run eval -- --research            phase 3 research on (ci_status, digests, ledger, proof levels, templates);
 *                                         without it each follows its NOGITA_* flag in .env, off by default
 *   npm run eval -- --routing compare     every case with model routing off, then on, and the two side by side;
 *                                         --routing on|off runs one (default: NOGITA_MODEL_ROUTING). The stronger
 *                                         model is ANTHROPIC_ROUTING_MODEL, else Sonnet.
 *
 * Needs ANTHROPIC_API_KEY (from .env or the environment); ANTHROPIC_AGENT_MODEL picks the model as in production.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ALL_RESEARCH_FEATURES, loadDotEnv, researchFeatures } from '../../src/app/config.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../../src/adapters/anthropic.ts';
import { CASES, DIMENSIONS } from './cases.ts';
import { runCase, scoreCase, summarize, type CaseScore, type Summary } from './harness.ts';

const { values } = parseArgs({ options: {
  case: { type: 'string', multiple: true }, group: { type: 'string', multiple: true }, repeat: { type: 'string', default: '1' },
  json: { type: 'string' }, 'no-json': { type: 'boolean', default: false }, research: { type: 'boolean', default: false }, routing: { type: 'string' },
} });
loadDotEnv();
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  process.stderr.write('Set ANTHROPIC_API_KEY (in .env or the environment) to run the eval set.\n');
  process.exit(2);
}
const repeat = Math.max(1, Number(values.repeat) || 1);
const cases = CASES.filter(item => (!values.case?.length || values.case.includes(item.id)) &&
  (!values.group?.length || values.group.includes(item.group)));
if (!cases.length) {
  process.stderr.write(`No such case. Cases: ${CASES.map(item => item.id).join(', ')}\n`);
  process.exit(2);
}
const routing = values.routing ?? (process.env.NOGITA_MODEL_ROUTING === 'true' ? 'on' : 'off');
if (!['on', 'off', 'compare'].includes(routing)) {
  process.stderr.write('--routing is on, off or compare.\n');
  process.exit(2);
}
const routingModel = process.env.ANTHROPIC_ROUTING_MODEL?.trim() || 'claude-sonnet-5-5';
const research = values.research ? ALL_RESEARCH_FEATURES : researchFeatures(process.env);
const researchOn = Object.entries(research).filter(([, on]) => on).map(([feature]) => feature);

interface Pass { routing: boolean; model: string; summary: Summary; ms: number; scores: CaseScore[]; runs: unknown[] }

async function runAll(routed: boolean): Promise<Pass> {
  const model = new AnthropicBrain(key!, process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, fetch, {}, {},
    { model: process.env.ANTHROPIC_AGENT_MODEL, thinking: process.env.ANTHROPIC_AGENT_THINKING === 'on' ? 'default' : 'off',
      routing: routed, routingModel });
  process.stdout.write(`Eval: ${cases.length} case(s) x ${repeat} on ${model.agentModel}; routing ${routed ? `on (${routingModel})` : 'off'}; ` +
    `research ${researchOn.join(', ') || 'off'}\n\n`);
  const scores: CaseScore[] = [];
  const runs: unknown[] = [];
  const began = Date.now();
  for (const item of cases) {
    for (let attempt = 0; attempt < repeat; attempt++) {
      const run = await runCase(model, item, { research });
      const score = scoreCase(item, run);
      scores.push(score);
      runs.push({ id: item.id, turns: run.turns, tools: run.tools, stops: run.stops, writes: run.calls.filter(call =>
        ['createTask', 'updateTask', 'postMessage', 'openDraft'].includes(call.method)), ms: run.ms, error: run.error, score,
        ...(run.missions ? { missions: run.missions.map(mission => ({ id: mission.id, status: mission.status, result: mission.result })) } : {}) });
      const failed = score.checks.filter(check => !check.pass);
      process.stdout.write(`${score.passed ? 'PASS' : 'FAIL'} ${item.id}${repeat > 1 ? ` #${attempt + 1}` : ''} (${(run.ms / 1000).toFixed(1)} s, ` +
        `${run.tools.length ? run.tools.join(' ') : 'no tools'}; stops ${run.stops.join(' ')})\n`);
      for (const check of failed) process.stdout.write(`     x ${check.dimension}: ${check.name}\n`);
      if (!score.passed) {
        const last = run.turns.at(-1);
        if (run.error) process.stdout.write(`     error: ${run.error}\n`);
        if (score.claims?.unbacked.length) process.stdout.write(`     no source: ${score.claims.unbacked.join(', ')}\n`);
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
  const { claims } = summary;
  process.stdout.write(`  claims with a source ${(100 * claims.share).toFixed(0)}%  (${claims.backed}/${claims.total}; the phase 3 gate is 90%)\n\n`);
  return { routing: routed, model: model.agentModel, summary, ms: Date.now() - began, scores, runs };
}

const passes: Pass[] = [];
for (const routed of routing === 'compare' ? [false, true] : [routing === 'on']) passes.push(await runAll(routed));

if (passes.length === 2) {
  const [off, on] = passes as [Pass, Pass];
  const pct = (share: number) => `${(100 * share).toFixed(0)}%`;
  const row = (name: string, a: string, b: string) => process.stdout.write(`  ${name.padEnd(15)} ${a.padStart(7)} ${b.padStart(7)}\n`);
  process.stdout.write(`Routing        ${'off'.padStart(7)} ${'on'.padStart(7)}\n`);
  row('passed', `${off.summary.passed}/${off.summary.cases}`, `${on.summary.passed}/${on.summary.cases}`);
  for (const dimension of DIMENSIONS) row(dimension, pct(off.summary.dimensions[dimension].score), pct(on.summary.dimensions[dimension].score));
  row('claims sourced', pct(off.summary.claims.share), pct(on.summary.claims.share));
  row('time', `${(off.ms / 1000).toFixed(0)} s`, `${(on.ms / 1000).toFixed(0)} s`);
  for (const [index, score] of off.scores.entries()) {
    const other = on.scores[index]!;
    if (score.passed !== other.passed) process.stdout.write(`  ${other.passed ? 'passes only with routing' : 'fails only with routing'}: ${score.id}\n`);
  }
}
const jsonPath = values['no-json'] ? undefined : values.json ?? join('.eval', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ research, at: new Date().toISOString(),
    passes: passes.map(pass => ({ routing: pass.routing, model: pass.model, summary: pass.summary, ms: pass.ms, runs: pass.runs })) }, null, 1)}\n`);
  process.stdout.write(`wrote ${jsonPath}\n`);
}
