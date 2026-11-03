/**
 * P7-1 (throwaway): the live Meet of 2026-11-01 replayed to Gemini. Attendee's recording is the call's mix, so only
 * Roee's utterances (from Attendee's transcript times) are kept and the old Nogita is muted, as production never feeds
 * her own voice back. Gemini hears Roee's real hesitations at their real times; the same count is made on what the
 * deployed Nogita (legacy turn-taking) actually did in that meeting.
 *
 *   node --experimental-transform-types tools/gemini-spike/recording.ts [--repeat 5]
 *
 * "Jumped in": she started inside one of his utterances, or in a pause he went on from within 2 s.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../../src/app/config.ts';
import { pcmToFloat } from '../voice-lab/audio.ts';
import { createNoise } from '../voice-lab/noise.ts';
import { GeminiRig } from './rig.ts';
import { estimateGeminiUsd } from './cost.ts';

const { values } = parseArgs({ options: { repeat: { type: 'string', default: '5' }, voice: { type: 'string', default: 'Kore' } } });
loadDotEnv();
const env = process.env as Record<string, string>;
const DIR = '.voice-lab/recordings';
const RECORDING_START = Date.parse('2026-11-01T15:09:19.009Z'); // Attendee: recording_permission_granted
const RESUME_MS = 2_000;

interface Utterance { speaker_name: string; timestamp_ms: number; duration_ms: number; transcription: { transcript: string } }
const transcript = JSON.parse(readFileSync(`${DIR}/meet-2026-11-01.transcript.json`, 'utf8')) as Utterance[];
const segments = transcript.map(u => ({ who: u.speaker_name === 'Nogita' ? 'nogita' : 'roee', start: u.timestamp_ms - RECORDING_START,
  end: u.timestamp_ms - RECORDING_START + u.duration_ms, text: u.transcription.transcript }));
const roee = segments.filter(s => s.who === 'roee');

const mix = pcmToFloat(readFileSync(`${DIR}/meet-2026-11-01.pcm`));
const track = new Float32Array(mix.length);
const at = (ms: number) => Math.max(0, Math.min(mix.length, Math.round(ms * 16)));
for (const s of roee) track.set(mix.subarray(at(s.start - 250), at(s.end + 250)), at(s.start - 250));
for (const s of segments.filter(s => s.who === 'nogita')) track.fill(0, at(s.start), at(s.end));

/** Her speech starts that jumped in on him, given starts in recording time. */
function jumpedIn(starts: readonly number[]): Array<{ at: number; why: string }> {
  return starts.flatMap(t => {
    const inside = roee.find(s => t > s.start + 100 && t < s.end - 100);
    if (inside) return [{ at: t, why: `inside "${inside.text.slice(0, 40)}"` }];
    const before = roee.filter(s => s.end <= t).at(-1);
    const after = roee.find(s => s.start >= t);
    if (before && after && after.start - before.end <= RESUME_MS && t >= before.end)
      return [{ at: t, why: `in the pause between "${before.text.slice(0, 30)}" and "${after.text.slice(0, 30)}"` }];
    return [];
  });
}

// What the deployed Nogita did: the start of each of her bursts (utterances closer than 1 s apart are one burst).
const nogitaStarts: number[] = [];
let lastEnd = -Infinity;
for (const s of segments.filter(s => s.who === 'nogita')) {
  if (s.start - lastEnd > 1_000) nogitaStarts.push(s.start);
  lastEnd = s.end;
}
const live = jumpedIn(nogitaStarts);
console.log(`Live Meet (legacy): ${live.length} of ${nogitaStarts.length} answers jumped in`);
for (const item of live) console.log(`  ${(item.at / 1000).toFixed(1)} s ${item.why}`);

const SYSTEM = `You are Nogita, a teammate in a work meeting. Speak only when someone addresses you by name ("Nogita") or
is clearly continuing a conversation with you. When people have not finished their sentence, stay completely silent:
do not say "go ahead" or anything. If you are interrupted, stop. Answer in one or two short sentences. You cannot look
anything up in this session: for questions about the team's code, tasks or repository, say briefly that you would check.`;
const results: unknown[] = [];
for (let repetition = 1; repetition <= Number(values.repeat); repetition++) {
  const rig = new GeminiRig(env.GEMINI_API_KEY!, env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live', SYSTEM, values.voice);
  await rig.start([{ id: 'roee', noise: createNoise({ kind: 'quiet', snrDb: 60 }, 1) }]);
  const { start, ended } = rig.say('roee', track);
  await ended;
  await new Promise(resolve => setTimeout(resolve, 8_000));
  await rig.stop();
  const starts = rig.events.filter(e => e.type === 'audio_start').map(e => e.t - start);
  const jumped = jumpedIn(starts);
  const usd = estimateGeminiUsd(rig.live.usage);
  console.log(`Gemini r${repetition}: ${jumped.length} of ${starts.length} answers jumped in, $${usd.toFixed(3)}`);
  for (const item of jumped) console.log(`  ${(item.at / 1000).toFixed(1)} s ${item.why}`);
  results.push({ repetition, starts, jumped, usd, said: rig.said.map(s => s.text).join(''), usage: rig.live.usage });
}
writeFileSync(`${DIR}/gemini-replay.json`, JSON.stringify({ live: { starts: nogitaStarts, jumped: live }, gemini: results }, null, 1));
process.exit(0);
