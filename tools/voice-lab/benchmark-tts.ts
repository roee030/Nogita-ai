/** Blind, same-text TTS comparison. Writes randomized WAV clips, a private manifest and latency JSON/Markdown. */
import { parseArgs } from 'node:util';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadDotEnv } from '../../src/app/config.ts';
import { pcmToFloat, wav } from './audio.ts';
import { renderBlindRatingCsv, runTtsBenchmark, summarizeTtsBenchmark, type TtsBenchmarkProvider, type TtsBenchmarkSample } from './tts-benchmark.ts';
import { cartesiaTtsBenchmarkProvider, deepgramTtsBenchmarkProvider } from './tts-providers.ts';

const CORPUS = [
  ['http-429', 'HTTP status four twenty-nine means the client sent too many requests. Back off, respect the retry header, and try again later.'],
  ['queue-or-cron', 'Use a queue when each reminder needs retries, visibility, and independent scaling. A cron job is fine only for kicking off the scan that enqueues due reminders.'],
  ['project', 'Nogita is a meeting teammate that listens when invited, answers from the team’s code and tools, and can carry out explicitly requested work.'],
  ['retry-worker', 'The retry worker uses exponential backoff with jitter, so repeated failures spread out instead of hammering the dependency at the same time.'],
  ['database-index', 'A database index keeps an ordered lookup structure so reads can find matching rows without scanning the whole table. Writes cost a little more because the index must stay current.'],
  ['cache', 'A cache avoids repeating slow work by keeping a recent result close to the caller. The trade-off is staleness, so every cache needs an expiry or invalidation rule.'],
  ['web-request', 'A client sends an HTTP request, the server routes it to a handler, and the handler calls the application logic. The response then travels back over the same connection.'],
  ['service-queue', 'A queue separates producers from workers. It absorbs traffic spikes, supports retries, and lets each side scale without forcing callers to wait for the work to finish.'],
  ['incident', 'The important part is to contain the impact first, preserve enough evidence to understand the failure, and assign one person to coordinate the recovery.'],
  ['task-owner', 'The payment retry issue is still open and does not have an owner. I would assign it before Thursday’s release rather than leave it as a verbal follow-up.'],
  ['pull-request', 'Keep the pull request small enough to review in one sitting. Explain the behavior change, show the tests that protect it, and call out any migration or rollback step.'],
  ['rate-limit', 'A rate limit protects a service from overload and unfair use. Good clients slow down, add jitter, and avoid retrying every failed request at once.'],
  ['deployment', 'Deploy the reversible infrastructure change first, verify health and traffic, then enable the behavior behind a flag. That keeps rollback fast if the new path misbehaves.'],
  ['authentication', 'Authentication proves who the caller is; authorization decides what that caller may do. Keep those checks separate so identity never silently grants a permission.'],
  ['observability', 'Logs explain individual events, metrics show trends, and traces connect work across services. Together they let you move from a symptom to the responsible request.'],
  ['webhook', 'Verify the webhook signature over the raw body, reject old timestamps, and make processing idempotent. That prevents tampering, replay, and duplicate side effects.'],
  ['feature-flag', 'A feature flag separates deployment from release. Start with internal traffic, watch the acceptance metrics, and keep the old path available until the new one is proven.'],
  ['meeting-summary', 'Dana owns the login fix, Avi is checking the webhook retries, and the onboarding review still needs a follow-up. The release risk is the unowned payment retry issue.'],
  ['clarification', 'Sure, which service do you want me to check?'],
  ['short-confirmation', 'Yep, I found it. The timestamp check is in the Slack request verification path.'],
] as const;

const { values } = parseArgs({ options: {
  providers: { type: 'string', default: 'deepgram,cartesia' }, limit: { type: 'string', default: '20' },
  out: { type: 'string' }, 'cartesia-voice': { type: 'string' }, 'deepgram-model': { type: 'string' },
} });
loadDotEnv();
const env = process.env;
const requested = new Set(values.providers.split(',').map(value => value.trim()).filter(Boolean));
const providers: TtsBenchmarkProvider[] = [];
if (requested.has('deepgram')) {
  if (!env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY is required for the Deepgram benchmark');
  providers.push(deepgramTtsBenchmarkProvider(env.DEEPGRAM_API_KEY, values['deepgram-model'] ?? env.DEEPGRAM_TTS_MODEL));
}
if (requested.has('cartesia')) {
  if (!env.CARTESIA_API_KEY) throw new Error('CARTESIA_API_KEY is required for the Cartesia benchmark');
  providers.push(cartesiaTtsBenchmarkProvider(env.CARTESIA_API_KEY, values['cartesia-voice']));
}
if (!providers.length || [...requested].some(name => !['deepgram', 'cartesia'].includes(name))) {
  throw new Error('providers must contain deepgram and/or cartesia');
}
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 2 || limit > CORPUS.length) throw new Error(`limit must be between 2 and ${CORPUS.length}`);
const corpus = CORPUS.slice(0, limit).map(([id, text]) => ({ id, text }));
const startedAt = new Date().toISOString();
const out = resolve(values.out ?? join('.voice-lab', 'tts-benchmarks', startedAt.replace(/[:.]/g, '-')));
await mkdir(join(out, 'clips'), { recursive: true });

const clips: Array<{ sample: TtsBenchmarkSample; audio: Buffer; sampleRate: number }> = [];
const samples = await runTtsBenchmark(providers, corpus, (sample, audio, sampleRate) => { clips.push({ sample, audio, sampleRate }); });
for (let i = clips.length - 1; i > 0; i--) {
  const j = randomInt(i + 1);
  [clips[i], clips[j]] = [clips[j]!, clips[i]!];
}
const manifest: Array<Record<string, unknown>> = [];
for (const [index, clip] of clips.entries()) {
  if (clip.sampleRate !== 16_000) throw new Error(`unsupported sample rate ${clip.sampleRate}`);
  const blindId = `clip-${String(index + 1).padStart(3, '0')}`;
  await writeFile(join(out, 'clips', `${blindId}.wav`), wav([pcmToFloat(clip.audio)]));
  const source = corpus.find(item => item.id === clip.sample.textId)!;
  manifest.push({ blindId, ...clip.sample, text: source.text });
}
const summary = summarizeTtsBenchmark(samples);
await writeFile(join(out, 'report.json'), JSON.stringify({ startedAt, corpus, summary, samples }, null, 2));
await writeFile(join(out, 'manifest.private.json'), JSON.stringify({ warning: 'Keep private until listening scores are locked.', clips: manifest }, null, 2));
await writeFile(join(out, 'ratings.csv'), renderBlindRatingCsv(manifest.map(clip => String(clip.blindId))));
const lines = ['# TTS benchmark', '', `Started: ${startedAt}`, '',
  '| Provider | Model | Voice | Phase | Success | TTFA p50 / p90 | Total p50 / p90 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...summary.map(group => `| ${group.provider} | ${group.model} | ${group.voice} | ${group.phase} | ${group.successes}/${group.attempts} | ${group.ttfa.p50 ?? '—'} / ${group.ttfa.p90 ?? '—'} ms | ${group.total.p50 ?? '—'} / ${group.total.p90 ?? '—'} ms |`),
  '', 'Listen to the randomized files in `clips/` and fill `ratings.csv` before opening `manifest.private.json`.', ''];
await writeFile(join(out, 'report.md'), lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\nBlind clips: ${join(out, 'clips')}\nPrivate manifest: ${join(out, 'manifest.private.json')}`);
