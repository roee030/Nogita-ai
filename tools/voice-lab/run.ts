/**
 * Nogita voice lab: spoken conversations with background noise against the real voice pipeline, outside any
 * meeting. Measures the silence between the end of each question and Nogita's first sound, and checks what
 * she did. Jira and Slack writes are intercepted unless --live-writes is given; reads are live.
 *
 *   npm run voice-lab -- [--scenario quiet-standup,stump] [--judge] [--stt flux-english] [--live-writes]
 *                        [--noise cafe] [--snr 5] [--router-quiet-ms 1200] [--frame-ms 20] [--list]
 *
 * Needs NOGITA_MODE=live, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY and AUTHORIZED_ACTOR_IDS in .env.
 * Output: .voice-lab/reports/<time>/ (report.html, transcript.md, report.md, report.json, one WAV per scenario).
 */
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { createDependencies, loadDotEnv } from '../../src/app/config.ts';
import { AllowlistPolicy } from '../../src/core/policy.ts';
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
  'live-writes': { type: 'boolean', default: false }, eot: { type: 'string' },
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

// Each person needs their own identity (the engine tracks who asked what). The first authorized participant
// speaks as the configured owner; the others get lab identities that the lab's policy also authorizes.
const actorIdFor = (participantId: string, index: number) => index === 0 ? authorizedIds[0]! : `lab:${participantId}`;
const labIds = new Set([...authorizedIds, ...SCENARIOS.flatMap(s => s.participants.map((p, i) => actorIdFor(p.id, i)))]);
dependencies.policy = new AllowlistPolicy(labIds);

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

// Writes are logged on the running rig. By default they never leave the lab and get a placeholder receipt;
// with --live-writes they really create the task or post the message.
let rig: VoiceRig | undefined;
let writes = 0;
const liveWrites = values['live-writes'];
const createTask = dependencies.board.createTask.bind(dependencies.board);
dependencies.board.createTask = async (input): Promise<ActionReceipt> => {
  writes++;
  const receipt = liveWrites ? await createTask(input)
    : { provider: 'voice-lab', kind: 'task' as const, label: `LAB-${writes}`, url: `https://example.invalid/LAB-${writes}` };
  rig?.log('write', { text: `task: ${input.title}${input.assigneeId ? ` (assignee ${input.assigneeId})` : ''} — ${input.description.slice(0, 300)}`,
    detail: liveWrites ? `${receipt.label} ${receipt.url}` : 'intercepted' });
  return receipt;
};

// Every lookup is logged under the agent's tool name, so a report shows where she looked ("search_tasks: ...").
function traceReads(port: object, tools: Record<string, string>): void {
  const target = port as Record<string, unknown>;
  for (const [method, tool] of Object.entries(tools)) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = async (...args: unknown[]) => {
      rig?.log('tool', { text: `${tool}: ${args.filter(arg => typeof arg === 'string' || typeof arg === 'number').join(', ').slice(0, 160)}` });
      return (original as (...a: unknown[]) => unknown).apply(port, args);
    };
  }
}
traceReads(dependencies.code, { findEvidence: 'search_code', readFile: 'read_file', listFiles: 'list_files', recentCommits: 'recent_commits' });
traceReads(dependencies.board, { searchTasks: 'search_tasks', getTask: 'get_task' });
const realChat = dependencies.chat;
const chat: ChatPort | undefined = realChat && { name: realChat.name,
  listChannels: () => realChat.listChannels(), readChannel: (c, l) => realChat.readChannel(c, l),
  ...(realChat.searchMessages ? { searchMessages: (q: string, l?: number) => realChat.searchMessages!(q, l) } : {}),
  ...(realChat.readThread ? { readThread: (c: string, t: string) => realChat.readThread!(c, t) } : {}),
  postMessage: async (channel, text): Promise<ActionReceipt> => {
    writes++;
    const receipt = liveWrites ? await realChat.postMessage(channel, text)
      : { provider: 'voice-lab', kind: 'message' as const, label: `message ${writes}`, url: `https://example.invalid/msg-${writes}` };
    rig?.log('write', { text: `message: #${channel}: ${text.slice(0, 120)}`, detail: liveWrites ? receipt.url : 'intercepted' });
    return receipt;
  } };
if (chat) traceReads(chat, { listChannels: 'list_channels', readChannel: 'read_channel', searchMessages: 'search_messages', readThread: 'read_thread' });

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
  routerQuietMs: String(routerQuietMs ?? 1200), frameMs: String(frameMs), writes: liveWrites ? 'live' : 'intercepted',
  eot: values.eot ?? '0.8', thinking: env.ANTHROPIC_AGENT_THINKING === 'on' ? 'on' : 'off' };
const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  console.log(`\n▶ ${scenario.title}`);
  const voices = new Map(scenario.participants.map(p => [p.id, p.voice]));
  const audio: Float32Array[] = [];
  for (const turn of scenario.turns) audio.push(await synthesizeTurn(turn, voices.get(turn.speaker)!, synthesize));
  rig = new VoiceRig({ deepgramApiKey: env.DEEPGRAM_API_KEY, sttMode, ttsModel: env.DEEPGRAM_TTS_MODEL,
    dependencies: { ...dependencies, chat }, routerQuietMs, frameMs, eotThreshold: values.eot ? Number(values.eot) : undefined,
    // The chat fallback makes a raised hand visible to the lab (LabMeeting has no native hand).
    engineOptions: { handRaiseFallback: 'chat' } });
  const errors: string[] = [];
  let records: Awaited<ReturnType<typeof playScenario>> = [];
  try {
    await rig.start(scenario.participants.map((p, i) => ({
      id: p.id, name: p.name, mic: p.mic,
      actor: p.authorized
        ? { id: actorIdFor(p.id, i), displayName: p.name, verified: true }
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
  for (const error of errors) console.log(`  ! ${error}`);
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
