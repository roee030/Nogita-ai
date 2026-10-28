import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionUsageRegistry } from '../src/app/session-usage.ts';

test('session usage estimates Attendee bot time and combines meeting-scoped AI usage', () => {
  let now = 1_000;
  const usage = new SessionUsageRegistry(0.50, () => now);
  usage.start('meeting-1', 'attendee');
  usage.recordTts('meeting-1', false);
  usage.recordExternalAction('meeting-1', 'create_task');
  now += 10 * 60_000;
  usage.end('meeting-1');

  assert.deepEqual(usage.report('meeting-1', {
    model: 'claude-haiku-5-5', modelCalls: 1, inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0.00015,
  }), {
    sessionId: 'meeting-1',
    provider: 'attendee',
    active: false,
    durationSeconds: 600,
    transcriptionMode: 'closed_captions',
    speechPipeline: 'closed_captions_mp3',
    meetingEstimatedUsd: 0.083333,
    deepgramEstimatedUsd: 0,
    tts: { requests: 1, failures: 1 },
    externalActions: { create_task: 1, code_lookup: 0 },
    ai: { model: 'claude-haiku-5-5', modelCalls: 1, inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0.00015 },
    totalEstimatedUsd: 0.083483,
    processingLatency: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    responseStages: {
      transcript_to_chat_ack: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      model_roundtrip: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      turn_to_first_speech_attempt: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    },
    speechLatency: {
      chat_mirror: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      tts_synthesis: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      audio_submission: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      speech_submission: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    },
  });
});

test('response stage samples are bounded, per meeting, and contain only numeric durations', () => {
  const usage = new SessionUsageRegistry();
  usage.start('a', 'attendee'); usage.start('b', 'attendee');
  for (let duration = 1; duration <= 205; duration++) {
    usage.recordResponseStage('a', 'model_roundtrip', duration);
  }
  usage.recordResponseStage('a', 'turn_to_first_speech_attempt', 800);
  usage.recordResponseStage('a', 'transcript_to_chat_ack', 350);
  usage.recordResponseStage('a', 'transcript_to_chat_ack', NaN);
  usage.recordResponseStage('b', 'model_roundtrip', 9999);
  const report = usage.report('a')!;
  assert.deepEqual(report.responseStages.model_roundtrip,
    { samples: 200, p50Ms: 105, p95Ms: 195, maxMs: 205 });
  assert.equal(report.responseStages.turn_to_first_speech_attempt.p50Ms, 800);
  assert.equal(report.responseStages.transcript_to_chat_ack.samples, 1);
  assert.equal(JSON.stringify(report).includes('9999'), false);
});

test('processing latency reports percentiles and ignores invalid samples', () => {
  const usage = new SessionUsageRegistry();
  usage.start('s', 'attendee');
  for (const duration of [100, 400, 200, 300, NaN, -1]) usage.recordResponse('s', duration);
  assert.deepEqual(usage.report('s')?.processingLatency,
    { samples: 4, p50Ms: 200, p95Ms: 400, maxMs: 400 });
});

test('speech latency is isolated by stage, bounded, and summarized without payload data', () => {
  const usage = new SessionUsageRegistry();
  usage.start('voice-a', 'attendee');
  for (const duration of [10, 20, 30, NaN, -1]) usage.recordSpeechStage('voice-a', 'chat_mirror', duration);
  for (let i = 1; i <= 205; i++) usage.recordSpeechStage('voice-a', 'audio_submission', i);
  usage.recordSpeechStage('voice-b', 'chat_mirror', 999);

  const report = usage.report('voice-a')!;
  assert.deepEqual(report.speechLatency.chat_mirror, { samples: 3, p50Ms: 20, p95Ms: 30, maxMs: 30 });
  assert.deepEqual(report.speechLatency.audio_submission, { samples: 200, p50Ms: 105, p95Ms: 195, maxMs: 205 });
  assert.deepEqual(report.speechLatency.tts_synthesis, { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  assert.equal(JSON.stringify(report).includes('999'), false);
});

test('session usage distinguishes estimate from free credits and rejects unknown sessions', () => {
  const usage = new SessionUsageRegistry(0.50, () => 10_000);
  usage.start('demo-1', 'demo');
  const report = usage.report('demo-1');
  assert.ok(report);
  assert.equal(report.meetingEstimatedUsd, 0);
  assert.equal(report.totalEstimatedUsd, 0);
  assert.deepEqual(report.tts, { requests: 0, failures: 0 });
  assert.deepEqual(report.externalActions, { create_task: 0, code_lookup: 0 });
  assert.equal(usage.report('missing'), undefined);
});

test('usage counters stay isolated between simultaneous sessions', () => {
  const usage = new SessionUsageRegistry();
  usage.start('one', 'attendee'); usage.start('two', 'attendee');
  usage.recordTts('one', true); usage.recordExternalAction('two', 'code_lookup');
  assert.deepEqual(usage.report('one')?.tts, { requests: 1, failures: 0 });
  assert.deepEqual(usage.report('two')?.tts, { requests: 0, failures: 0 });
  assert.deepEqual(usage.report('one')?.externalActions, { create_task: 0, code_lookup: 0 });
  assert.deepEqual(usage.report('two')?.externalActions, { create_task: 0, code_lookup: 1 });
});

test('realtime voice cost uses submitted PCM bytes and TTS characters as a clearly separate estimate', () => {
  const usage = new SessionUsageRegistry(0.50, () => 10_000);
  usage.start('realtime', 'attendee', true);
  usage.recordDeepgramSttBytes('realtime', 32_000 * 60);
  usage.recordDeepgramTtsCharacters('realtime', 1000);
  const report = usage.report('realtime')!;
  assert.equal(report.deepgramUsage?.sttAudioSeconds, 60);
  assert.equal(report.deepgramUsage?.ttsCharacters, 1000);
  assert.equal(report.deepgramEstimatedUsd, 0.0358);
  assert.equal(report.speechPipeline, 'deepgram_aura_stream');
  assert.equal(report.totalEstimatedUsd, report.meetingEstimatedUsd + report.deepgramEstimatedUsd);
});
