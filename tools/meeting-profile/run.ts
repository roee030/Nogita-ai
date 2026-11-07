/**
 * P9-5: the offline check of meeting-type inference, against the real model.
 *
 *   npm run meeting-profile                     the synthetic labeled set
 *   npm run meeting-profile -- --repeat 3       each one three times
 *   npm run meeting-profile -- --file x.json    a local consented set, [{id, profile, lines, title?}]; never commit it
 *
 * Changes nothing in the product. It prints results for review, and its targets are proposals (P9-6).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { AnthropicBrain, DEFAULT_ANTHROPIC_MODEL } from '../../src/adapters/anthropic.ts';
import { inferProfile, renderReport, score, type Scored } from './infer.ts';
import { LABELED, type LabeledMeeting } from './labels.ts';

const { values } = parseArgs({ options: { repeat: { type: 'string', default: '1' }, file: { type: 'string' } } });
loadDotEnv();
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  process.stderr.write('Set ANTHROPIC_API_KEY (in .env or the environment).\n');
  process.exit(2);
}
const meetings: readonly LabeledMeeting[] = values.file ? JSON.parse(readFileSync(values.file, 'utf8')) as LabeledMeeting[] : LABELED;
const model = new AnthropicBrain(key, process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, fetch, {}, {}, { model: process.env.ANTHROPIC_AGENT_MODEL, thinking: 'off' });
const results: Scored[] = [];
for (let run = 0; run < Math.max(1, Number(values.repeat) || 1); run++) {
  for (const meeting of meetings) {
    const { profile, confidence } = await inferProfile(model, meeting);
    results.push({ id: meeting.id, expected: meeting.profile, got: profile, confidence });
  }
}
console.log(`${meetings.length} meetings x ${values.repeat} on ${model.agentModel}\n`);
console.log(renderReport(score(results)));
