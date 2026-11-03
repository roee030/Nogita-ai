import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, gateA, measureRun, percentile, type VoiceBenchResult } from '../tools/voice-bench/result.ts';
import type { LabEvent } from '../tools/voice-lab/rig.ts';
import type { Scenario } from '../tools/voice-lab/scenarios.ts';
import { estimateGeminiUsd } from '../tools/gemini-spike/cost.ts';
import { downsample24to16 } from '../tools/gemini-spike/rig.ts';

const roee = { id: 'roee', name: 'Roee', voice: 'v', authorized: true, mic: 'open' as const };
const scenario = (turns: Scenario['turns']): Scenario => ({ name: 't', title: 't', noise: { kind: 'quiet', snrDb: 60 }, participants: [roee], turns });
const ev = (t: number, type: LabEvent['type'], participant?: string): LabEvent => ({ t, type, ...(participant ? { participant } : {}) });

test('a question answered after it ends, talk to others left alone: first sound measured, nothing premature', () => {
  const s = scenario([
    { speaker: 'roee', say: 'Nogita, what landed today?', expect: { respond: 'speak' } },
    { speaker: 'roee', say: 'Dana, lunch?', expect: { respond: 'silent' } },
  ]);
  const m = measureRun(s, [ev(0, 'speech_start', 'roee'), ev(2000, 'speech_end', 'roee'), ev(3200, 'audio_start'), ev(5000, 'audio_stop'),
    ev(7000, 'speech_start', 'roee'), ev(8000, 'speech_end', 'roee')]);
  assert.deepEqual([m.questions, m.lostQuestions, m.responsesToNonAddressed, m.prematureResponses, m.talkOver], [1, 0, 0, 0, 0]);
  assert.deepEqual(m.firstAudibleMs, [1200]);
});

test('answering a half-sentence in its pause is premature and talk-over; answering side talk is counted', () => {
  const s = scenario([
    { speaker: 'roee', say: ['Nogita, I want to know', 'how many tasks are open'], pauseMs: 1500, expect: { respond: 'speak' } },
    { speaker: 'roee', say: 'Dana, lunch?', expect: { respond: 'silent' } },
  ]);
  const m = measureRun(s, [ev(0, 'speech_start', 'roee'), ev(1800, 'audio_start'), ev(2400, 'audio_stop'), ev(4000, 'speech_end', 'roee'),
    ev(6000, 'speech_start', 'roee'), ev(7000, 'speech_end', 'roee'), ev(7600, 'audio_start'), ev(8600, 'audio_stop')]);
  assert.equal(m.prematureResponses, 1);
  assert.equal(m.talkOver, 1);
  assert.equal(m.responsesToNonAddressed, 1);
});

test('barge-in stop time, a kept backchannel and a cough pause', () => {
  const s = scenario([
    { speaker: 'roee', say: 'Nogita, explain the release.', expect: { respond: 'speak' } },
    { speaker: 'roee', say: 'mm-hm', bargeIn: { afterAudioMs: 1000, kind: 'backchannel' }, expect: { respond: 'any' } },
    { speaker: 'roee', say: 'cough', perturbation: { afterAudioMs: 1000, kind: 'cough' }, expect: { respond: 'any' } },
    { speaker: 'roee', say: 'Stop.', bargeIn: { afterAudioMs: 1000, kind: 'interrupt' }, expect: { respond: 'any' } },
  ]);
  const m = measureRun(s, [ev(0, 'speech_start', 'roee'), ev(1000, 'speech_end', 'roee'), ev(2000, 'audio_start'),
    ev(3000, 'speech_start', 'roee'), ev(3300, 'speech_end', 'roee'), // mm-hm: she goes on
    ev(5000, 'speech_start', 'roee'), ev(5200, 'speech_end', 'roee'), ev(5400, 'audio_stop'), ev(6200, 'audio_start'), // cough: paused
    ev(8000, 'speech_start', 'roee'), ev(8300, 'speech_end', 'roee'), ev(8240, 'audio_stop')]);
  assert.deepEqual(m.backchannels, { kept: 1, total: 1 });
  assert.deepEqual(m.falsePauses, { paused: 1, total: 1 });
  assert.deepEqual(m.interruptionMs, [240]);
  assert.equal(m.talkOver, 0, 'resuming after a cough is not starting over someone');
});

test('gate A: thresholds set before the run, Hebrew and cost left to a person when missing', () => {
  const base = combine('v2', 'x', []);
  const v2: VoiceBenchResult = { ...base, lostQuestions: 1, interruptionMs: { n: 6, p50: 200, p95: 300 }, usdPerMeetingHour: { estimated: 1, actual: null } };
  const good: VoiceBenchResult = { ...base, lostQuestions: 1, interruptionMs: { n: 6, p50: 250, p95: 380 }, firstAudibleMs: { n: 20, p50: 1400, p95: 3000 },
    usdPerMeetingHour: { estimated: 1.4, actual: null } };
  const lines = new Map(gateA(good, v2).map(line => [line.metric, line.pass]));
  assert.equal(lines.get('interruptionMs p95'), true);
  assert.equal(lines.get('usdPerMeetingHour'), true);
  assert.equal(lines.get('hebrewQuality'), null);
  const slow = new Map(gateA({ ...good, interruptionMs: { n: 6, p50: 300, p95: 450 }, usdPerMeetingHour: { estimated: 1.6, actual: null },
    prematureResponses: 1 }, v2).map(line => [line.metric, line.pass]));
  assert.equal(slow.get('interruptionMs p95'), false, 'within 500 ms but more than v2 + 100 ms');
  assert.equal(slow.get('usdPerMeetingHour'), false, 'more than 1.5 x v2');
  assert.equal(slow.get('prematureResponses'), false);
});

test('percentiles, Gemini pricing and the 24 to 16 kHz conversion', () => {
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([], 0.5), null);
  assert.equal(estimateGeminiUsd({ promptTokens: 1_000_000, audioPromptTokens: 1_000_000, textPromptTokens: 0, responseTokens: 1_000_000,
    audioResponseTokens: 1_000_000, turns: 1 }), 15);
  const pcm = Buffer.alloc(2 * 2400);
  assert.equal(downsample24to16(pcm).length, 1600);
});
