/**
 * Plays a scenario on a VoiceRig like people in a room would: wait for Nogita to finish, pause, speak the
 * next line (or talk over her for a barge-in), then turn the event log into per-turn timings.
 */
import { STILL_WORKING, agentProgressPhrases, progressPhrases } from '../../src/core/engine.ts';
import { concat, msToSamples } from './audio.ts';
import type { LabEvent, VoiceRig } from './rig.ts';
import type { Scenario, Turn } from './scenarios.ts';
import type { Synthesize } from './tts.ts';

export interface TurnTiming {
  /** Mic time of the first and last spoken word. */
  speechStart: number;
  speechEnd: number;
  /** Everything below is milliseconds after the last word, except sttFirstActivity (after the first word). */
  sttFirstActivity?: number;
  sttFinal?: number;
  utterance?: number;
  firstSpeakCall?: number;
  /** The headline number: silence the room hears between the question and Nogita's voice. */
  firstAudio?: number;
  /** First sound that is not a canned filler ("One sec."): her own lead-in or the answer. */
  firstContentAudio?: number;
  answerEnd?: number;
  /** Barge-in only: from the interrupter's first word until Nogita's previous answer went quiet. */
  bargeInStop?: number;
}

const FILLERS = new Set([...agentProgressPhrases, ...progressPhrases, ...STILL_WORKING]);

export interface TurnRecord {
  index: number;
  turn: Turn;
  script: string;
  timing: TurnTiming;
  heard?: string;
  spoken: string[];
  chat: string[];
  writes: string[];
  interruptedByNoise: boolean;
  /** A hand-raise line was posted to chat before this turn started. */
  handRaisedBefore: boolean;
  events: LabEvent[];
}

export async function synthesizeTurn(turn: Turn, voice: string, synthesize: Synthesize): Promise<Float32Array> {
  const parts = Array.isArray(turn.say) ? turn.say : [turn.say];
  const audio: Float32Array[] = [];
  for (const [i, part] of parts.entries()) {
    if (i > 0) audio.push(new Float32Array(msToSamples(turn.pauseMs ?? 800)));
    audio.push(await synthesize(voice, part));
  }
  return concat(audio);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

/** Nogita idle for `quietMs` in a row. */
async function settle(rig: VoiceRig, quietMs: number, timeoutMs: number): Promise<void> {
  let idleSince = rig.busy ? Infinity : performance.now();
  await until(() => {
    if (rig.busy) { idleSince = Infinity; return false; }
    if (idleSince === Infinity) idleSince = performance.now();
    return performance.now() - idleSince >= quietMs;
  }, timeoutMs, 25);
}

export async function playScenario(rig: VoiceRig, scenario: Scenario, audio: Float32Array[],
  options: { warmupMs?: number; answerTimeoutMs?: number; onTurn?: (index: number, turn: Turn) => void } = {}): Promise<TurnRecord[]> {
  await sleep(options.warmupMs ?? 1500);
  const marks: Array<{ start: number; end: number }> = [];
  const ends: Promise<unknown>[] = [];
  for (const [index, turn] of scenario.turns.entries()) {
    options.onTurn?.(index, turn);
    if (turn.overlapPreviousMs !== undefined && marks.length) {
      // Two people at once: start while the previous speaker is still talking.
      const previousStart = marks.at(-1)!.start;
      await until(() => performance.now() >= previousStart + turn.overlapPreviousMs!, 60_000, 5);
    } else if (turn.bargeIn) {
      // Talk over her once she has been audible for a while.
      const previousEnd = marks.at(-1)?.end ?? 0;
      await until(() => {
        const start = rig.events.filter(event => event.type === 'audio_start' && event.t > previousEnd).at(-1);
        return !!start && rig.audioActive && performance.now() - start.t >= turn.bargeIn!.afterAudioMs;
      }, options.answerTimeoutMs ?? 45_000);
    } else {
      await settle(rig, 600, options.answerTimeoutMs ?? 45_000);
      await sleep(turn.gapMs ?? 800);
    }
    const spoken = rig.say(turn.speaker, audio[index]!);
    const mark = { start: spoken.start, end: Infinity };
    marks.push(mark);
    ends.push(spoken.ended.then(end => { mark.end = end; }));
    if (scenario.turns[index + 1]?.overlapPreviousMs !== undefined) continue;
    await spoken.ended;
    // Give the pipeline time to hear the end of the turn and start (or decide not to start) an answer.
    await sleep(2_500);
    const heardBy = performance.now() + 8_000;
    await until(() => rig.events.some(event => event.type === 'utterance' && event.t > mark.start) ||
      performance.now() > heardBy, 10_000, 25);
  }
  await Promise.all(ends);
  await settle(rig, 1_500, options.answerTimeoutMs ?? 45_000);
  return scenario.turns.map((turn, index) => record(rig.events, turn, index, marks[index]!, marks[index + 1]?.start));
}

function record(events: LabEvent[], turn: Turn, index: number, mark: { start: number; end: number }, nextStart?: number): TurnRecord {
  const window = events.filter(event => event.t >= mark.start && (nextStart === undefined || event.t < nextStart));
  const participantUuid = `lab_${turn.speaker}`;
  const after = (type: LabEvent['type'], from: number, predicate: (event: LabEvent) => boolean = () => true) =>
    events.find(event => event.type === type && event.t >= from && (nextStart === undefined || event.t < nextStart) && predicate(event));
  const finals = window.filter(event => event.type === 'stt_final' && event.participant === participantUuid);
  // A turn can reach the engine in pieces (Flux ends a turn at "Agreed." and starts another); all are this speaker's.
  const utterances = window.filter(event => event.type === 'utterance' && event.participant === participantUuid);
  const utterance = utterances.find(event => event.t >= mark.end) ?? utterances.at(-1);
  const firstSpeak = after('speak_call', mark.end);
  const firstAudio = after('audio_start', mark.end);
  // Content is anything but a canned filler: the model's own lead-in or the answer itself.
  const contentCall = after('speak_call', mark.end, event => !FILLERS.has(event.text ?? ''));
  const contentAudio = contentCall && events.find(event => event.type === 'audio_start' && event.t >= contentCall.t &&
    (nextStart === undefined || event.t < nextStart));
  const stops = window.filter(event => event.type === 'audio_stop' && event.t > (firstAudio?.t ?? Infinity));
  const activity = after('stt_activity', mark.start, event => event.participant === participantUuid);
  const lastFinalBeforeUtterance = finals.filter(event => !utterance || event.t <= utterance.t).at(-1);
  const rel = (event?: LabEvent) => event ? Math.round(event.t - mark.end) : undefined;
  const timing: TurnTiming = {
    speechStart: mark.start, speechEnd: mark.end,
    sttFirstActivity: activity ? Math.round(activity.t - mark.start) : undefined,
    sttFinal: rel(lastFinalBeforeUtterance ?? finals.at(-1)),
    utterance: rel(utterance), firstSpeakCall: rel(firstSpeak), firstAudio: rel(firstAudio),
    firstContentAudio: rel(contentAudio), answerEnd: rel(stops.at(-1)),
  };
  if (turn.bargeIn) {
    const stop = events.find(event => event.type === 'audio_stop' && event.t >= mark.start);
    timing.bargeInStop = stop ? Math.round(stop.t - mark.start) : undefined;
  }
  const spoken = window.filter(event => event.type === 'speak_call' && event.t >= mark.end).map(event => event.text ?? '');
  return {
    index, turn, script: (Array.isArray(turn.say) ? turn.say : [turn.say]).join(' '), timing,
    heard: utterances.length ? utterances.map(event => event.text).join(' ')
      : finals.length ? finals.map(event => event.text).join(' ') : undefined,
    spoken,
    chat: window.filter(event => event.type === 'chat' && event.t >= mark.end && !spoken.includes(event.text ?? ''))
      .map(event => event.text ?? ''),
    writes: window.filter(event => event.type === 'write').map(event => event.text ?? ''),
    // An interruption nobody scripted: the hub heard "speech" (noise, a cough) and cut her off.
    handRaisedBefore: events.some(event => event.type === 'chat' && event.t < mark.start && /has something to add/i.test(event.text ?? '')),
    interruptedByNoise: window.some(event => event.type === 'speak_error' && /interrupt/i.test(event.detail ?? '') && event.t > mark.end),
    events: window,
  };
}
