/**
 * Nogita voice lab: spoken conversations with background noise against the real voice pipeline, outside any
 * meeting. Measures the silence between the end of each question and Nogita's first sound, and checks what
 * she did. Jira and Slack writes are intercepted; reads are live.
 *
 *   npm run voice-lab -- [--scenario quiet-standup,stump] [--judge] [--stt flux-english]
 *                        [--noise cafe] [--snr 5] [--router-quiet-ms 1200] [--frame-ms 20] [--list]
 *
 * Needs NOGITA_MODE=live, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY and AUTHORIZED_ACTOR_IDS in .env.
 * Output: .voice-lab/reports/<time>/ (report.md, report.html, report.json, one WAV per scenario).
 */
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { createDependencies, loadDotEnv } from '../../src/app/config.ts';
import type { ActionReceipt, ChatPort } from '../../src/core/contracts.ts';
import { playScenario, synthesizeTurn } from './conversation.ts';
import { createNoise, type NoiseKind } from './noise.ts';
import { summarize, writeReport, type ScenarioResult } from './report.ts';
import { VoiceRig } from './rig.ts';
import { BACKGROUND_LINES, BACKGROUND_VOICES, SCENARIOS, type Scenario } from './scenarios.ts';
import { judge, scoreTurn } from './score.ts';
import { deepgramSynthesizer } from './tts.ts';

const { values } = parseArgs({ options: {
  scenario: { type: 'string' }, judge: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
  stt: { type: 'string' }, noise: { type: 'string' }, snr: { type: 'string' },
  'router-quiet-ms': { type: 'string' }, 'frame-ms': { type: 'string' }, out: { type: 'string' },
} });

if (values.list) {
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.name.padEnd(16)} ${scenario.title} — ${scenario.turns.length} turns`);
  }
  process.exit(0);
}

loadDotEnv();
const env = process.env;
if (!env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY is required for the voice lab');
const dependencies = createDependencies(env);
if (!dependencies.agent) throw new Error('Set NOGITA_MODE=live and ANTHROPIC_API_KEY to run the voice lab');
const authorizedIds = (env.AUTHORIZED_ACTOR_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!authorizedIds.length) throw new Error('AUTHORIZED_ACTOR_IDS must name at least one internal ID');

const wanted = values.scenario?.split(',').map(s => s.trim()).filter(Boolean);
let scenarios: Scenario[] = wanted ? SCENARIOS.filter(s => wanted.includes(s.name)) : SCENARIOS;
if (wanted && scenarios.length !== wanted.length) throw new Error(`unknown scenario; try --list`);
if (values.noise || values.snr) {
  scenarios = scenarios.map(s => ({ ...s, noise: {
    kind: (values.noise as NoiseKind | undefined) ?? s.noise.kind, snrDb: values.snr ? Number(values.snr) : s.noise.snrDb } }));
}
const sttMode = (values.stt ?? env.DEEPGRAM_STT_MODE) === 'flux-english' ? 'flux-english' : 'nova3-multilingual';
const routerQuietMs = values['router-quiet-ms'] ? Number(values['router-quiet-ms']) : undefined;
const frameMs = values['frame-ms'] ? Number(values['frame-ms']) : 20;

// Writes never leave the lab: they are logged on the running rig and answered with a placeholder receipt.
let rig: VoiceRig | undefined;
let writes = 0;
dependencies.board.createTask = async (input): Promise<ActionReceipt> => {
  writes++;
  rig?.log('write', { text: `task: ${input.title}${input.assigneeId ? ` (assignee ${input.assigneeId})` : ''}` });
  return { provider: 'voice-lab', kind: 'task', label: `LAB-${writes}`, url: `https://example.invalid/LAB-${writes}` };
};
const realChat = dependencies.chat;
const chat: ChatPort | undefined = realChat && { name: realChat.name,
  listChannels: () => realChat.listChannels(), readChannel: (c, l) => realChat.readChannel(c, l),
  ...(realChat.searchMessages ? { searchMessages: (q: string, l?: number) => realChat.searchMessages!(q, l) } : {}),
  ...(realChat.readThread ? { readThread: (c: string, t: string) => realChat.readThread!(c, t) } : {}),
  postMessage: async (channel, text): Promise<ActionReceipt> => {
    writes++;
    rig?.log('write', { text: `message: #${channel}: ${text.slice(0, 120)}` });
    return { provider: 'voice-lab', kind: 'message', label: `message ${writes}`, url: `https://example.invalid/msg-${writes}` };
  } };

const synthesize = deepgramSynthesizer(env.DEEPGRAM_API_KEY, resolve('.voice-lab/cache'));
const needsBabble = scenarios.some(s => s.noise.kind === 'office' || s.noise.kind === 'cafe');
const babble: Float32Array[] = [];
if (needsBabble) {
  for (const [i, line] of BACKGROUND_LINES.entries()) {
    babble.push(await synthesize(BACKGROUND_VOICES[i % BACKGROUND_VOICES.length]!, line),
      await synthesize(BACKGROUND_VOICES[(i + 3) % BACKGROUND_VOICES.length]!, line));
  }
}

console.log('Indexing the repository...');
if (dependencies.code.prepare) await dependencies.code.prepare();

const startedAt = new Date().toISOString();
const settings = { stt: sttMode, model: dependencies.agent.agentModel, tts: env.DEEPGRAM_TTS_MODEL ?? 'aura-2-thalia-en',
  routerQuietMs: String(routerQuietMs ?? 1200), frameMs: String(frameMs) };
const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  console.log(`\n▶ ${scenario.title}`);
  const voices = new Map(scenario.participants.map(p => [p.id, p.voice]));
  const audio: Float32Array[] = [];
  for (const turn of scenario.turns) audio.push(await synthesizeTurn(turn, voices.get(turn.speaker)!, synthesize));
  rig = new VoiceRig({ deepgramApiKey: env.DEEPGRAM_API_KEY, sttMode, ttsModel: env.DEEPGRAM_TTS_MODEL,
    dependencies: { ...dependencies, chat }, routerQuietMs, frameMs,
    engineOptions: { handRaiseFallback: 'none' } });
  const errors: string[] = [];
  let records: Awaited<ReturnType<typeof playScenario>> = [];
  try {
    await rig.start(scenario.participants.map((p, i) => ({
      id: p.id, name: p.name, mic: p.mic,
      actor: p.authorized
        ? { id: authorizedIds[i % authorizedIds.length]!, displayName: p.name, verified: true }
        : { id: `unmapped:lab:${p.id}`, displayName: p.name, verified: false },
      noise: createNoise(scenario.noise, 1000 + i * 77, babble),
    })));
    records = await playScenario(rig, scenario, audio, {
      onTurn: (index, turn) => console.log(`  ${index + 1}. ${turn.speaker}: ${Array.isArray(turn.say) ? turn.say.join(' … ') : turn.say}`) });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await rig.stop();
  }
  errors.push(...new Set(rig.events.filter(e => e.type === 'error').map(e => e.detail ?? 'error')));
  const turns = records.map(record => ({ record, score: scoreTurn(record) }));
  if (values.judge && env.ANTHROPIC_API_KEY) {
    const model = env.VOICE_LAB_JUDGE_MODEL || 'claude-sonnet-5-5';
    await Promise.all(turns.map(async turn => { turn.score.judgement = await judge(turn.record, env.ANTHROPIC_API_KEY!, model).catch(() => undefined); }));
  }
  for (const { record, score } of turns) {
    const gap = record.timing.firstAudio === undefined ? '   —   ' : `${(record.timing.firstAudio / 1000).toFixed(2)} s`;
    console.log(`  ${score.passed ? '✓' : '✗'} #${record.index + 1} gap ${gap}  heard: "${record.heard ?? ''}"`);
    for (const check of score.checks.filter(c => !c.ok)) console.log(`      ✗ ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
  }
  results.push({ scenario, turns, room: rig.room.samples().slice(), nogita: rig.nogita.samples().slice(), errors });
}

const summary = summarize(results, settings, startedAt);
const out = resolve(values.out ?? join('.voice-lab', 'reports', startedAt.replace(/[:.]/g, '-')));
await writeReport(out, summary, results);
const s = summary.responseGap;
console.log(`\nResponse gap: p50 ${s.p50} ms, p90 ${s.p90} ms, max ${s.max} ms (n=${s.count})`);
console.log(`Passed ${summary.passed}/${summary.total}; name recognized ${summary.addressHeard.heard}/${summary.addressHeard.total}`);
console.log(`Report: ${join(out, 'report.html')}`);
process.exit(0);
