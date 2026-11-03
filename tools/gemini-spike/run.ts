/**
 * P7-1 (throwaway): plays voice-lab scenarios to one Gemini Live session each, at real time, with the same noise, and
 * measures turn-taking with the shared voice-bench definitions. No tools, no Nogita engine, no identity: this answers
 * only "is Gemini better at taking turns", before anything is built (docs/VOICE_ENGINE_PLAN.md, gate A).
 *
 *   node --experimental-transform-types tools/gemini-spike/run.ts --scenario barge-in,cut-off --repeat 5
 *        [--safety-repeat 10] [--hebrew] [--budget-usd 25] [--out .voice-lab/gemini-spike/<name>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { concat, wav } from '../voice-lab/audio.ts';
import { playScenario, synthesizeTurn } from '../voice-lab/conversation.ts';
import { createNoise } from '../voice-lab/noise.ts';
import type { VoiceRig } from '../voice-lab/rig.ts';
import { BACKGROUND_LINES, BACKGROUND_VOICES, SCENARIOS, type Scenario } from '../voice-lab/scenarios.ts';
import { deepgramSynthesizer, type Synthesize } from '../voice-lab/tts.ts';
import { measureRun, type RunMetrics } from '../voice-bench/result.ts';
import { GeminiRig, downsample24to16 } from './rig.ts';
import { geminiSpeech } from './live.ts';
import { HEBREW_SCENARIOS } from './hebrew.ts';
import { estimateGeminiUsd } from './cost.ts';

const { values } = parseArgs({ options: {
  scenario: { type: 'string' }, repeat: { type: 'string', default: '5' }, 'safety-repeat': { type: 'string' },
  safety: { type: 'string', default: 'other-people-conversation,long-pauses,stalled-speaker,room-crosstalk' },
  hebrew: { type: 'boolean', default: false }, 'budget-usd': { type: 'string', default: '25' }, out: { type: 'string' },
  model: { type: 'string' }, voice: { type: 'string', default: 'Kore' },
} });
loadDotEnv();
const env = process.env as Record<string, string>;
const model = values.model ?? env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live';
const budget = Number(values['budget-usd']);
const safety = new Set(values.safety!.split(','));
const all = [...SCENARIOS, ...(values.hebrew ? HEBREW_SCENARIOS : [])];
const wanted = values.scenario?.split(',').map(name => name.trim()).filter(Boolean);
const scenarios: Scenario[] = wanted ? wanted.map(name => all.find(s => s.name === name) ?? (() => { throw new Error(`unknown scenario ${name}`); })())
  : values.hebrew ? HEBREW_SCENARIOS : [];
const repeat = Math.max(1, Number(values.repeat) || 1);
const safetyRepeat = Math.max(repeat, Number(values['safety-repeat'] ?? repeat * 2) || repeat);
const out = resolve(values.out ?? join('.voice-lab', 'gemini-spike', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });

// The same instruction a production Nogita would get about when to speak; no tools here, so no lookups.
const SYSTEM = `You are Nogita, a teammate in a work meeting with several people on one call. Speak only when someone
addresses you by name ("Nogita") or is clearly continuing a conversation with you. When people talk to each other,
think aloud, or have not finished their sentence, stay completely silent: do not say "go ahead", "mm-hm" or anything.
If you are interrupted, stop. Answer in one or two short sentences. You cannot look anything up in this session: for
questions about the team's code, tasks or chat, say briefly that you would check, without inventing facts.`;

const deepgram = deepgramSynthesizer(env.DEEPGRAM_API_KEY!, resolve('.voice-lab/cache'));
const gemini: Synthesize = async (voice, text) => downsample24to16(await geminiSpeech(env.GEMINI_API_KEY!, text, voice));
const babble: Float32Array[] = [];
if (scenarios.some(s => s.noise.kind === 'office' || s.noise.kind === 'cafe')) {
  for (const [i, line] of BACKGROUND_LINES.entries()) babble.push(await deepgram(BACKGROUND_VOICES[i % BACKGROUND_VOICES.length]!, line));
}

let spent = 0;
const runs: Array<RunMetrics & { repetition: number; usd: number; durationMs: number; tokens: unknown }> = [];
outer: for (const scenario of scenarios) {
  const times = safety.has(scenario.name) ? safetyRepeat : repeat;
  const synthesize = HEBREW_SCENARIOS.includes(scenario) ? gemini : deepgram;
  const voices = new Map(scenario.participants.map(p => [p.id, p.voice]));
  const audio: Float32Array[] = [];
  for (const turn of scenario.turns) audio.push(await synthesizeTurn(turn, voices.get(turn.speaker)!, synthesize));
  for (let repetition = 1; repetition <= times; repetition++) {
    if (spent >= budget) { console.log(`Budget of $${budget} reached; stopping.`); break outer; }
    const rig = new GeminiRig(env.GEMINI_API_KEY!, model, SYSTEM, values.voice);
    const started = performance.now();
    try {
      await rig.start(scenario.participants.flatMap((p, i) => p.sharesMicWith ? [] : [{
        id: p.id, noise: createNoise(scenario.noise, 1000 + i * 77, babble) }]));
      await playScenario(rig as unknown as VoiceRig, scenario, audio, { answerTimeoutMs: 30_000 });
    } catch (error) {
      rig.log('error', { detail: error instanceof Error ? error.message : String(error) });
    } finally {
      await rig.stop();
    }
    const durationMs = performance.now() - started;
    const usd = estimateGeminiUsd(rig.live.usage);
    spent += usd;
    const metrics = measureRun(scenario, rig.events);
    runs.push({ ...metrics, repetition, usd, durationMs: Math.round(durationMs), tokens: rig.live.usage });
    const name = `${scenario.name}-r${repetition}`;
    writeFileSync(join(out, `${name}.json`), JSON.stringify({ scenario: scenario.name, repetition, metrics, usd, durationMs,
      usage: rig.live.usage, said: rig.said, heard: rig.heard, events: rig.events }, null, 1));
    if (repetition === 1) writeFileSync(join(out, `${name}.wav`), wav([concat(rig.recording)]));
    const errors = [...new Set(rig.events.filter(e => e.type === 'error').map(e => e.detail))];
    console.log(`${name}: lost ${metrics.lostQuestions}/${metrics.questions}, to others ${metrics.responsesToNonAddressed}, premature ` +
      `${metrics.prematureResponses}, over ${metrics.talkOver}, stop ${metrics.interruptionMs.join('/') || '-'} ms, first ` +
      `${metrics.firstAudibleMs.join('/') || '-'} ms, $${usd.toFixed(3)} (total $${spent.toFixed(2)})${errors.length ? ` ! ${errors.join('; ')}` : ''}`);
  }
}
writeFileSync(join(out, 'runs.json'), JSON.stringify({ engine: 'gemini-live', model, runs, spent }, null, 1));
console.log(`Runs: ${runs.length}; spent ~$${spent.toFixed(2)}; ${out}`);
process.exit(0);
