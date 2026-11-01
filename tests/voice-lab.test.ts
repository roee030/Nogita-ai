import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import { createDependencies } from '../src/app/config.ts';
import { directlyAddressesNogita, normalizeWakeWord } from '../src/core/policy.ts';
import { FRAME_SAMPLES, SAMPLE_RATE, floatToPcm, msToSamples, pcmToFloat, rms, trimSilence, wav } from '../tools/voice-lab/audio.ts';
import { playScenario, record as recordEvents, synthesizeTurn, type TurnRecord } from '../tools/voice-lab/conversation.ts';
import { SPEECH_RMS, createNoise, createPerturbation } from '../tools/voice-lab/noise.ts';
import { VoiceRig, expectedProviderClose, parseWarmupMode } from '../tools/voice-lab/rig.ts';
import { SCENARIOS, micOf, type Scenario, type Turn } from '../tools/voice-lab/scenarios.ts';
import { conversationFailures, machineTells, scoreTurn, stats, wordErrorRate } from '../tools/voice-lab/score.ts';
import { markdown, summarize, transcriptLines, transcriptMarkdown, writeReport, type ScenarioResult } from '../tools/voice-lab/report.ts';
import { conversationStats, questionLedger } from '../tools/voice-lab/conversation-metrics.ts';

test('speech recognition variants of the wake word are restored only where someone addresses Nogita', () => {
  for (const [heard, expected] of [
    ['Nokita. How do you verify speakers?', 'Nogita. How do you verify speakers?'],
    ['No Gita, what is this project?', 'Nogita, what is this project?'],
    ['So for the retry. Notita, what happens when Jira is down?', 'So for the retry. Nogita, what happens when Jira is down?'],
    ['Hey, Nikita, can you check?', 'Hey, Nogita, can you check?'],
    ['Lokita, what are the open tasks?', 'Nogita, what are the open tasks?'],
    ['Lukita, what does HTTP status 503 mean?', 'Nogita, what does HTTP status 503 mean?'],
  ]) {
    assert.equal(normalizeWakeWord(heard!), expected);
    assert.equal(directlyAddressesNogita(normalizeWakeWord(heard!)), true, heard);
  }
  for (const text of ['I asked Nikita about it yesterday.', 'Nokia phones are old.', 'Notice the retry logic.', 'Nadia, can you check?']) {
    assert.equal(normalizeWakeWord(text), text);
  }
  assert.equal(directlyAddressesNogita('Hey, Nogita, what changed?'), true);
  assert.equal(directlyAddressesNogita('Thanks, Nogita. That is all.'), true);
  assert.equal(directlyAddressesNogita('No Nogita, open a task.'), true);
  assert.equal(directlyAddressesNogita('So for the retry logic, Nogita, what happens when Jira is down?'), true);
  assert.equal(directlyAddressesNogita('Dana, Nogita, and Avi joined the call.'), false);
});

test('a finished question to Nogita skips the long router quiet window; other speech keeps it', async () => {
  const delays: number[] = [];
  const router = new AttendeeCommandRouter(async () => {}, async () => {},
    { schedule: (_work, delayMs) => { delays.push(delayMs); return delayMs; }, cancel: () => {} });
  router.beginSession('s');
  const actor = { id: 'roee', displayName: 'Roee', verified: true };
  const say = (speakerUuid: string, text: string, eventId: string) =>
    void router.accept({ sessionId: 's', botId: 'bot_1', speakerUuid, utterance: { eventId, actor, text } });
  say('a', 'Nokita, what changed in the last commits?', 'e1');
  say('b', 'Nogita, what happens when', 'e2');
  say('c', 'I think we are done?', 'e3');
  assert.deepEqual(delays, [300, 1200, 1200]);
  router.endSession('s');
});

test('audio helpers keep PCM, levels and WAV layout exact', () => {
  const tone = new Float32Array(SAMPLE_RATE).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE));
  const back = pcmToFloat(floatToPcm(tone));
  assert.ok(Math.abs(rms(back) - rms(tone)) < 1e-3);
  const file = wav([tone, tone]);
  assert.equal(file.length, 44 + SAMPLE_RATE * 2 * 2);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt16LE(22), 2);
});

test('silence trimming ignores low-level synthesis noise around the spoken frames', () => {
  const prefix = new Float32Array(msToSamples(300)).map((_, i) => 0.006 * Math.sin(2 * Math.PI * 90 * i / SAMPLE_RATE));
  const speech = new Float32Array(msToSamples(500)).map((_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE));
  const samples = new Float32Array(prefix.length + speech.length + prefix.length);
  samples.set(prefix); samples.set(speech, prefix.length); samples.set(prefix, prefix.length + speech.length);
  const trimmed = trimSilence(samples);
  assert.ok(trimmed.length >= msToSamples(540), `kept ${trimmed.length * 1000 / SAMPLE_RATE} ms`);
  assert.ok(trimmed.length <= msToSamples(600), `kept ${trimmed.length * 1000 / SAMPLE_RATE} ms`);
});

test('noise beds sit at the requested SNR below the reference speech level', () => {
  for (const kind of ['white', 'pink', 'brown', 'hum', 'keyboard', 'street'] as const) {
    const noise = createNoise({ kind, snrDb: 10 }, 7).next(SAMPLE_RATE * 10);
    const expected = SPEECH_RMS / 10 ** (10 / 20);
    assert.ok(Math.abs(rms(noise) - expected) / expected < 0.2, `${kind}: ${rms(noise)} vs ${expected}`);
  }
  const babbleLine = new Float32Array(SAMPLE_RATE).map((_, i) => Math.sin(i / 7) * 0.1);
  const office = createNoise({ kind: 'office', snrDb: 15 }, 3, [babbleLine]).next(SAMPLE_RATE * 5);
  assert.ok(rms(office) > 0);
  assert.deepEqual(createNoise({ kind: 'pink', snrDb: 5 }, 1).next(64), createNoise({ kind: 'pink', snrDb: 5 }, 1).next(64));
});

test('cough, typing and laughter are deterministic acoustic clips that bypass participant TTS', async () => {
  for (const kind of ['cough', 'typing', 'laughter'] as const) {
    const clip = createPerturbation(kind);
    assert.ok(clip.length >= msToSamples(500), `${kind} duration`);
    assert.ok(rms(clip) > 0.03, `${kind} RMS ${rms(clip)}`);
    assert.ok(Buffer.from(createPerturbation(kind, 17).buffer)
      .equals(Buffer.from(createPerturbation(kind, 17).buffer)), `${kind} deterministic`);
    let ttsCalls = 0;
    const turn: Turn = { speaker: 'roee', say: `[${kind}]`, perturbation: { kind, afterAudioMs: 500 },
      expect: { respond: 'any' } };
    const synthesized = await synthesizeTurn(turn, 'unused', async () => { ttsCalls++; return new Float32Array(); });
    assert.ok(Buffer.from(synthesized.buffer).equals(Buffer.from(clip.buffer)), `${kind} PCM`);
    assert.equal(ttsCalls, 0);
  }
});

test('every built-in scenario names its own participants and a known noise kind', () => {
  for (const scenario of SCENARIOS) {
    const ids = new Set(scenario.participants.map(p => p.id));
    for (const turn of scenario.turns) assert.ok(ids.has(turn.speaker), `${scenario.name}: ${turn.speaker}`);
    assert.ok(scenario.participants.every(p => p.voice !== 'aura-2-thalia-en'), 'participants never use Nogita\'s voice');
  }
});

test('the false-pause scenario injects every required sound during active playback', () => {
  const scenario = SCENARIOS.find(candidate => candidate.name === 'false-pause');
  assert.ok(scenario);
  assert.deepEqual(scenario.turns.flatMap(turn => turn.perturbation?.kind ?? []), ['cough', 'typing', 'laughter']);
  assert.ok(scenario.turns.filter(turn => turn.perturbation).every(turn => (turn.perturbation?.afterAudioMs ?? 0) > 0));
});

test('multi-speaker scenarios cover queued questions, other people talking, and a correction', () => {
  const queued = SCENARIOS.find(candidate => candidate.name === 'two-speaker-questions');
  assert.ok(queued);
  assert.deepEqual(queued.turns.map(turn => turn.speaker), ['roee', 'dana']);
  assert.ok(queued.turns[1]?.afterPreviousMs !== undefined);
  assert.deepEqual(queued.turns[0]?.expect.questionStatus, ['answered']);
  assert.equal(queued.turns[0]?.expect.respond, 'any');
  assert.equal(queued.turns[1]?.expect.mentions?.length, 2);

  const others = SCENARIOS.find(candidate => candidate.name === 'other-people-conversation');
  assert.ok(others);
  assert.ok(others.turns.length >= 2);
  assert.ok(others.turns.every(turn => turn.expect.respond === 'silent'));

  const correction = SCENARIOS.find(candidate => candidate.name === 'speaker-correction');
  assert.ok(correction);
  assert.match(String(correction.turns[1]?.say), /no,? (?:sorry,? )?i meant/i);
  assert.ok(correction.turns[1]?.afterPreviousMs !== undefined);
  assert.ok(correction.turns[1]?.expect.forbid?.includes('engine.ts'));
});

test('meeting-room scenarios share one mic, cut people off mid-word, and overlap speakers on the same mic', () => {
  for (const scenario of SCENARIOS) {
    for (const p of scenario.participants.filter(p => p.sharesMicWith)) {
      const owner = scenario.participants.find(candidate => candidate.id === p.sharesMicWith);
      assert.ok(owner && !owner.sharesMicWith, `${scenario.name}: ${p.id} shares a mic that has no owner`);
    }
    for (const turn of scenario.turns) assert.ok(turn.cutAt === undefined || (turn.cutAt > 0 && turn.cutAt < 1), scenario.name);
  }
  const room = SCENARIOS.find(candidate => candidate.name === 'meeting-room')!;
  assert.equal(micOf(room, 'dana'), 'roee');
  assert.equal(micOf(room, 'noa'), 'noa');
  const sameMicOverlap = (scenario: Scenario) => scenario.turns.some((turn, i) => turn.overlapPreviousMs !== undefined && i > 0 &&
    micOf(scenario, turn.speaker) === micOf(scenario, scenario.turns[i - 1]!.speaker));
  assert.ok(sameMicOverlap(room));
  assert.ok(sameMicOverlap(SCENARIOS.find(candidate => candidate.name === 'room-crosstalk')!));

  const cutOff = SCENARIOS.find(candidate => candidate.name === 'cut-off')!;
  const cutIndex = cutOff.turns.findIndex(turn => turn.cutAt !== undefined);
  assert.ok(cutOff.turns[cutIndex + 1]?.afterPreviousMs !== undefined, 'someone jumps in right where the speaker was cut off');
  assert.ok(cutOff.turns.some(turn => Array.isArray(turn.say) && (turn.pauseMs ?? 800) < 500), 'a speaker restarts their own sentence');
  const pauses = SCENARIOS.find(candidate => candidate.name === 'long-pauses')!;
  assert.ok(pauses.turns.every(turn => (turn.pauseMs ?? 0) >= 1_800));
});

test('a cut-off turn keeps only the start of the line and fades out', async () => {
  const tone = new Float32Array(msToSamples(1_000)).fill(0.5);
  const full = await synthesizeTurn({ speaker: 'roee', say: 'x', expect: { respond: 'any' } }, 'v', async () => tone);
  const cut = await synthesizeTurn({ speaker: 'roee', say: 'x', cutAt: 0.4, expect: { respond: 'any' } }, 'v', async () => tone);
  assert.equal(full.length, tone.length);
  assert.equal(cut.length, Math.round(tone.length * 0.4));
  assert.equal(cut[0], 0.5);
  assert.ok(Math.abs(cut.at(-1)!) < 0.01, 'no click at the cut');
});

function record(turn: Turn, fields: Partial<TurnRecord>): TurnRecord {
  return { index: 0, turn, script: String(turn.say), heard: String(turn.say), spoken: [], chat: [], writes: [], tools: [], spokeAfterUtterance: 0,
    interruptedByNoise: false, handRaisedBefore: false, events: [], timing: { speechStart: 0, speechEnd: 0 }, ...fields };
}

test('report counts lost questions and answers to conversations that were not hers', () => {
  const lost: Turn = { speaker: 'roee', say: 'Nogita, what changed?', expect: { respond: 'speak' } };
  const privateConversation: Turn = { speaker: 'dana', say: 'Avi, can you review this?', expect: { respond: 'silent' } };
  const lostRecord = record(lost, {});
  const strayRecord = record(privateConversation, {
    spoken: ['Sure, I can review it.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 500 },
  });
  const turns = [
    { record: lostRecord, score: scoreTurn(lostRecord) },
    { record: strayRecord, score: scoreTurn(strayRecord) },
  ];
  assert.deepEqual(conversationFailures(turns), { lostQuestions: 1, answersToOthers: 1 });

  const scenario: Scenario = { name: 'failures', title: 'failures', noise: { kind: 'quiet', snrDb: 60 },
    participants: [
      { id: 'roee', name: 'Roee', voice: 'unused', authorized: true, mic: 'open' },
      { id: 'dana', name: 'Dana', voice: 'unused', authorized: true, mic: 'open' },
    ], turns: [lost, privateConversation] };
  const result: ScenarioResult = { scenario, turns, room: new Float32Array(), nogita: new Float32Array(), errors: [], events: [] };
  const summary = summarize([result], {}, 'now');
  assert.deepEqual(summary.conversationFailures, { lostQuestions: 1, answersToOthers: 1 });
  const report = markdown(summary, [result]);
  assert.match(report, /Lost questions: \*\*1\*\*/);
  assert.match(report, /Answers to conversations that were not hers: \*\*1\*\*/);
});

test('lost-question count uses tracker completion and does not mistake filler for an answer', () => {
  const tracked: Turn = { speaker: 'roee', say: 'Nogita, what changed?',
    expect: { respond: 'any', questionStatus: ['answered'] } };
  const untracked: Turn = { speaker: 'dana', say: 'Nogita, what is open?', expect: { respond: 'speak' } };
  const cases = [
    { record: record(tracked, { questionStatus: 'answered' }), score: scoreTurn(record(tracked, { questionStatus: 'answered' })) },
    { record: record(tracked, { questionStatus: 'working' }), score: scoreTurn(record(tracked, { questionStatus: 'working' })) },
    { record: record(untracked, { spoken: ['Still on it.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 100 } }),
      score: scoreTurn(record(untracked, { spoken: ['Still on it.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 100 } })) },
    { record: record(untracked, { spoken: ['Three tasks are open.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 100 } }),
      score: scoreTurn(record(untracked, { spoken: ['Three tasks are open.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 100 } })) },
  ];
  assert.deepEqual(conversationFailures(cases), { lostQuestions: 2, answersToOthers: 0 });
});

test('scoring checks hearing, silence, required phrases, writes and interruptions', () => {
  assert.equal(wordErrorRate('Nogita what is this', 'Nokita what is this'), 0.25);
  assert.equal(wordErrorRate('a b', ''), 1);
  const ask: Turn = { speaker: 'roee', say: 'Nogita, what is the capital of Australia?',
    expect: { respond: 'speak', mentions: [['canberra']], write: 'none' } };
  const good = scoreTurn(record(ask, { spoken: ['Canberra.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 900 } }));
  assert.equal(good.passed, true);
  assert.equal(good.addressHeard, true);
  const misheard = scoreTurn(record(ask, { heard: 'Nokita what is the capital of Australia', spoken: [] }));
  assert.equal(misheard.addressHeard, true);
  assert.deepEqual(misheard.checks.filter(c => !c.ok).map(c => c.name), ['answered aloud', 'mentions canberra']);
  const noisy = scoreTurn(record(ask, { heard: 'Background words. From Nogita, what is the capital of Australia?',
    spoken: ['Canberra.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 900 } }));
  assert.equal(noisy.addressHeard, true);
  const quiet: Turn = { speaker: 'dana', say: 'Let us move on.', expect: { respond: 'silent' } };
  assert.equal(scoreTurn(record(quiet, { chat: ['I heard you.'] })).passed, false);
  assert.equal(scoreTurn(record(quiet, {})).passed, true);
  const wrote = scoreTurn(record(ask, { spoken: ['Canberra.'], writes: ['task: x'], interruptedByNoise: true,
    timing: { speechStart: 0, speechEnd: 0, firstAudio: 1 } }));
  assert.deepEqual(wrote.checks.filter(c => !c.ok).map(c => c.name), ['no write', 'not cut off']);
  assert.deepEqual(stats([3, 1, undefined, 2]), { count: 3, mean: 2, p50: 2, p90: 3, min: 1, max: 3 });
});

test('barge-in acceptance starts at scripted acoustic onset and uses the first output pause', () => {
  const turn: Turn = { speaker: 'roee', say: 'Nogita, stop.', bargeIn: { afterAudioMs: 500 },
    expect: { respond: 'silent', bargeInWithinMs: 300 } };
  const events = [
    { t: 1_000, type: 'speech_start' as const, participant: 'roee' },
    { t: 1_201, type: 'playback_pause' as const, latencyMs: 101, ms: 80, questionId: 2, playbackId: 3 },
    { t: 1_350, type: 'interrupt' as const, cause: 'voice' as const, latencyMs: 250, questionId: 2, playbackId: 3 },
    // This is deliberately later: gap detection is not the cancellation latency reported by the audio hub.
    { t: 1_798, type: 'audio_stop' as const },
    { t: 5_000, type: 'speech_end' as const, participant: 'roee' },
  ];
  const result = recordEvents(events, turn, 0, { start: 1_000, end: 5_000 });
  assert.equal(result.timing.bargeInStop, 281);
});

test('scoring distinguishes a harmless backchannel from a barge-in that must stop playback', () => {
  const backchannel: Turn = { speaker: 'roee', say: 'Yeah.', bargeIn: { afterAudioMs: 500, kind: 'backchannel' },
    expect: { respond: 'any' } };
  assert.equal(scoreTurn(record(backchannel, { events: [] })).passed, true);
  const cut = scoreTurn(record(backchannel, { events: [
    { t: 100, type: 'interrupt', cause: 'voice', latencyMs: 100, questionId: 1, playbackId: 1 },
  ] }));
  assert.deepEqual(cut.checks.filter(check => !check.ok).map(check => check.name), ['keeps talking through backchannel']);

  const interruption: Turn = { speaker: 'roee', say: 'Wait.', bargeIn: { afterAudioMs: 500, kind: 'interrupt' },
    expect: { respond: 'any', bargeInWithinMs: 300 } };
  assert.equal(scoreTurn(record(interruption, { timing: { speechStart: 0, speechEnd: 0, bargeInStop: 250 } })).passed, true);
});

test('run latency excludes playback carried through a backchannel turn', () => {
  const question: Turn = { speaker: 'roee', say: 'Nogita, explain queues.', expect: { respond: 'speak' } };
  const acknowledgement: Turn = { speaker: 'dana', say: 'Yeah.', bargeIn: { afterAudioMs: 500, kind: 'backchannel' },
    expect: { respond: 'any' } };
  const questionRecord = record(question, { spoken: ['Queues decouple work.'], timing: { speechStart: 0, speechEnd: 100, firstAudio: 1_000 } });
  const acknowledgementRecord = record(acknowledgement,
    { timing: { speechStart: 2_000, speechEnd: 2_200, firstAudio: 24_000, bargeInStop: 24_000 } });
  const scenario: Scenario = { name: 'latency', title: 'latency', noise: { kind: 'quiet', snrDb: 60 },
    participants: [{ id: 'roee', name: 'Roee', voice: 'aura-2-orion-en', authorized: true, mic: 'open' },
      { id: 'dana', name: 'Dana', voice: 'aura-2-luna-en', authorized: true, mic: 'open' }], turns: [question, acknowledgement] };
  const summary = summarize([{ scenario, turns: [{ record: questionRecord, score: scoreTurn(questionRecord) },
    { record: acknowledgementRecord, score: scoreTurn(acknowledgementRecord) }], room: new Float32Array(),
    nogita: new Float32Array(), errors: [], events: [] }], {}, '2026-10-31T00:00:00.000Z');
  assert.deepEqual(summary.responseGap, { count: 1, mean: 1_000, p50: 1_000, p90: 1_000, min: 1_000, max: 1_000 });
  assert.equal(summary.bargeInStop.count, 0);
  assert.deepEqual(summary.backchannels, { kept: 1, total: 1, falseStops: 0, falseStopRate: 0, upper95: 0.7935 });
});

test('summary reports acoustic false pauses with confidence and pause duration', () => {
  const perturbation: Turn = { speaker: 'roee', say: '[cough]', perturbation: { kind: 'cough', afterAudioMs: 500 },
    expect: { respond: 'any' } };
  const perturbationRecord = record(perturbation, { timing: { speechStart: 1_000, speechEnd: 1_700 }, events: [
    { t: 1_120, type: 'playback_pause', questionId: 1, playbackId: 4 },
    { t: 1_420, type: 'playback_resume', questionId: 1, playbackId: 4, ms: 300, outcome: 'timeout' },
  ] });
  const scenario: Scenario = { name: 'false-pause', title: 'false pause', noise: { kind: 'quiet', snrDb: 60 },
    participants: [{ id: 'roee', name: 'Roee', voice: 'unused', authorized: true, mic: 'open' }], turns: [perturbation] };
  const summary = summarize([{ scenario, turns: [{ record: perturbationRecord, score: scoreTurn(perturbationRecord) }],
    room: new Float32Array(), nogita: new Float32Array(), errors: [], events: perturbationRecord.events }], {}, 'now');
  assert.deepEqual(summary.falsePauses, { clean: 0, total: 1, pauses: 1, rate: 1, upper95: 1,
    duration: { count: 1, mean: 300, p50: 300, p90: 300, min: 300, max: 300 } });
  assert.equal(scoreTurn(perturbationRecord).passed, true);
  assert.equal(summary.total, 0);
});

test('the lab suppresses an abnormal TTS close only when it immediately follows an intentional interruption', () => {
  assert.equal(expectedProviderClose('tts', 1006, '', 150), true);
  assert.equal(expectedProviderClose('tts', 1006, '', 2_500), false);
  assert.equal(expectedProviderClose('stt', 1006, '', 150), false);
  assert.equal(expectedProviderClose('tts', 1000, 'speech interrupted'), true);
});

test('voice-lab warmup mode defaults to production and rejects ambiguous baselines', () => {
  assert.equal(parseWarmupMode(undefined), 'production');
  assert.equal(parseWarmupMode('production'), 'production');
  assert.equal(parseWarmupMode('cold'), 'cold');
  assert.throws(() => parseWarmupMode('off'), /warmup must be production or cold/);
});

/** Deepgram stand-ins: STT finalizes a turn after 300 ms of quiet; TTS returns 300 ms of tone per request. */
class FakeDeepgram extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  private voiced = false;
  private quietMs = 0;
  constructor(private readonly kind: 'stt' | 'tts', private readonly transcripts: string[]) {
    super();
    setImmediate(() => this.emit('open'));
  }
  send(data: Buffer | string): void {
    if (this.kind === 'stt') {
      const level = rms(pcmToFloat(data as Buffer));
      const frameMs = (data as Buffer).length / 2 / SAMPLE_RATE * 1000;
      if (level > 0.02) { this.voiced = true; this.quietMs = 0; return; }
      if (!this.voiced || (this.quietMs += frameMs) < 300) return;
      this.voiced = false;
      const transcript = this.transcripts.shift() ?? '';
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ is_final: true, speech_final: true,
        channel: { alternatives: [{ transcript }] } })), false));
      return;
    }
    const message = JSON.parse(String(data)) as { type: string };
    if (message.type !== 'Flush') return;
    setTimeout(() => {
      const tone = new Float32Array(msToSamples(300)).map((_, i) => 0.2 * Math.sin(i / 5));
      this.emit('message', floatToPcm(tone), true);
      this.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    }, 20);
  }
  close(): void { this.readyState = 3; setImmediate(() => this.emit('close')); }
}

test('cold voice-lab mode does not pre-open a TTS connection', async () => {
  const opened: string[] = [];
  const rig = new VoiceRig({ deepgramApiKey: 'test-key', dependencies: createDependencies({}), warmup: 'cold',
    createWebSocket: url => {
      opened.push(url);
      return new FakeDeepgram(url.includes('/v1/speak') ? 'tts' : 'stt', []) as never;
    } });
  await rig.start([{ id: 'roee', name: 'Roee', mic: 'open', actor: { id: 'roee', displayName: 'Roee', verified: true },
    noise: createNoise({ kind: 'quiet', snrDb: 60 }, 1) }]);
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(opened.some(url => url.includes('/v1/speak')), false, JSON.stringify(opened));
    assert.equal(opened.some(url => !url.includes('/v1/speak')), true, JSON.stringify(opened));
  } finally { await rig.stop(); }
});

test('two lines started on the same mic are mixed and each reports its own end', async () => {
  const rig = new VoiceRig({ deepgramApiKey: 'test-key', dependencies: createDependencies({}), warmup: 'cold',
    createWebSocket: url => new FakeDeepgram(url.includes('/v1/speak') ? 'tts' : 'stt', []) as never });
  await rig.start([{ id: 'roee', name: 'Roee', mic: 'open', actor: { id: 'roee', displayName: 'Roee', verified: true },
    noise: createNoise({ kind: 'quiet', snrDb: 60 }, 1) }]);
  try {
    const first = rig.say('roee', new Float32Array(msToSamples(400)).fill(0.2));
    const second = rig.say('roee', new Float32Array(msToSamples(200)).fill(0.3));
    const [firstEnd, secondEnd] = await Promise.all([first.ended, second.ended]);
    assert.ok(secondEnd < firstEnd, 'the shorter line ends first');
    const peak = rig.room.samples().reduce((max, sample) => Math.max(max, sample), 0);
    assert.ok(peak > 0.45, `both voices are heard at once (peak ${peak})`);
  } finally { await rig.stop(); }
});

test('the lab drives the real voice path end to end and times each stage', async () => {
  const transcripts = ['Nokita, how does login work?'];
  const rig = new VoiceRig({
    deepgramApiKey: 'test-key', dependencies: createDependencies({}), routerQuietMs: 1200,
    createWebSocket: url => new FakeDeepgram(url.includes('/v1/speak') ? 'tts' : 'stt', transcripts) as never,
  });
  const scenario: Scenario = { name: 'offline', title: 'offline', noise: { kind: 'quiet', snrDb: 60 },
    participants: [{ id: 'roee', name: 'Roee', voice: 'aura-2-orion-en', authorized: true, mic: 'open' }],
    turns: [{ speaker: 'roee', say: 'Nogita, how does login work?', expect: { respond: 'speak' } }] };
  const speech = new Float32Array(msToSamples(600)).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE));
  await rig.start([{ id: 'roee', name: 'Roee', mic: 'open', actor: { id: 'roee', displayName: 'Roee', verified: true },
    noise: createNoise({ kind: 'quiet', snrDb: 60 }, 1) }]);
  let records: TurnRecord[];
  try { records = await playScenario(rig, scenario, [speech], { warmupMs: 100, answerTimeoutMs: 10_000 }); }
  finally { await rig.stop(); }
  const [turn] = records;
  assert.equal(turn?.heard, 'Nogita, how does login work?');
  const t = turn!.timing;
  assert.ok(t.sttFinal! >= 250 && t.sttFinal! < 1_000, `stt ${t.sttFinal}`);
  // A finished question skips the 1.2 s router window.
  assert.ok(t.utterance! - t.sttFinal! < 600, `router ${t.utterance! - t.sttFinal!}`);
  assert.ok(t.firstSpeakCall! >= t.utterance! && t.firstAudio! >= t.firstSpeakCall!, JSON.stringify(t));
  assert.ok(turn!.spoken.length > 0);
  assert.equal(scoreTurn(turn!).passed, true);
  assert.ok(rig.room.length >= msToSamples(600) && rig.nogita.length > 0);
  assert.equal(rig.room.length % FRAME_SAMPLES, 0);
});

test('scoring checks lookups and response time, and the transcript shows every step', () => {
  const ask: Turn = { speaker: 'roee', say: "Nogita, what's in progress on the board?",
    expect: { respond: 'speak', tools: ['search_tasks'], firstSoundWithinMs: 2_000, contentWithinMs: 3_000 } };
  const events = [
    { t: 1_000, type: 'speak_call' as const, text: 'One sec.' },
    { t: 1_200, type: 'tool' as const, text: 'search_tasks: status = "In Progress"' },
    { t: 2_500, type: 'speak_call' as const, text: 'Two tasks are in progress.' },
    { t: 2_600, type: 'write' as const, text: 'task: Fix retries — from the meeting', detail: 'intercepted' },
  ];
  const good = record(ask, { spoken: ['One sec.', 'Two tasks are in progress.'], tools: ['search_tasks: status = "In Progress"'],
    events, timing: { speechStart: 0, speechEnd: 0, firstAudio: 1_100, firstContentAudio: 2_600 } });
  assert.equal(scoreTurn(good).passed, true);
  const slow = scoreTurn(record(ask, { spoken: ['Two tasks.'], tools: [],
    timing: { speechStart: 0, speechEnd: 0, firstAudio: 3_400, firstContentAudio: 3_400 } }));
  assert.deepEqual(slow.checks.filter(c => !c.ok).map(c => c.name), ['looked up search_tasks', 'first sound within 2 s', 'answer within 3 s']);

  const scenario = { name: 's', title: 'S', noise: { kind: 'quiet' as const, snrDb: 60 },
    participants: [{ id: 'roee', name: 'Roee', voice: 'aura-2-orion-en', authorized: true, mic: 'open' as const }], turns: [ask] };
  const [lines] = transcriptLines({ scenario, turns: [{ record: good, score: scoreTurn(good) }], room: new Float32Array(), nogita: new Float32Array(), errors: [], events: [] });
  assert.deepEqual(lines!.map(line => line.kind), ['person', 'bridge', 'tool', 'nogita', 'task', 'verdict']);
  assert.equal(lines![3]!.at, 2.5);
  assert.match(transcriptMarkdown([{ scenario, turns: [{ record: good, score: scoreTurn(good) }], room: new Float32Array(), nogita: new Float32Array(), errors: [], events: [] }]),
    /Jira task:\* Fix retries — from the meeting \[intercepted\]/);
});

test('report JSON keeps the scenario event stream needed to audit overlap metrics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nogita-voice-report-'));
  const turn: Turn = { speaker: 'roee', say: 'Nogita, stop.', expect: { respond: 'silent' } };
  const events = [
    { t: 10_000, type: 'speech_start' as const, participant: 'roee' },
    { t: 10_500, type: 'playback_received' as const, questionId: 1, playbackId: 2 },
    { t: 11_000, type: 'speech_end' as const, participant: 'roee' },
  ];
  const result: ScenarioResult = { scenario: { name: 'audit', title: 'audit', noise: { kind: 'quiet', snrDb: 60 },
    participants: [{ id: 'roee', name: 'Roee', voice: 'aura-2-orion-en', authorized: true, mic: 'open' }], turns: [turn] },
    turns: [], room: new Float32Array(), nogita: new Float32Array(), errors: [], events };
  try {
    await writeReport(directory, summarize([result], {}, '2026-10-30T00:00:00.000Z'), [result]);
    const json = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as { scenarios: Array<{ events?: unknown[] }> };
    assert.deepEqual(json.scenarios[0]?.events, events);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversation stats: what became of every question, early starts, speaking over people, duplicate writes', () => {
  const q = (t: number, detail: string, participant = 'lab_roee', text = 'what is in progress') =>
    ({ t, type: 'question' as const, participant, text, detail });
  const events = [
    q(0, '#1 speculative'), q(300, '#1 rolled_back: the speaker kept talking'),
    q(900, '#2 speculative'), q(1_000, '#2 working'), q(2_000, '#2 answering'), q(2_500, '#2 interrupted'),
    q(4_000, '#2 answering: resumed'), q(5_000, '#2 answered'),
    q(1_500, '#3 working', 'lab_dana', 'what changed'), q(1_600, '#3 working [recent commits]: asked again; one lookup is already running', 'lab_dana'),
    q(6_000, '#3 cancelled: asked to drop it', 'lab_dana'),
    q(7_000, '#4 working', 'lab_dana', 'who owns it'),
    { t: 8_000, type: 'speech_start' as const, participant: 'avi' },
    { t: 8_880, type: 'playback_received' as const, questionId: 4, playbackId: 9 },
    { t: 8_900, type: 'audio_start' as const }, { t: 8_950, type: 'audio_start' as const },
    { t: 9_000, type: 'speech_end' as const, participant: 'avi' },
    { t: 9_100, type: 'write' as const, text: 'task: Fix retries' }, { t: 9_200, type: 'write' as const, text: 'task: Fix retries' },
  ];
  const ledger = questionLedger(events);
  assert.deepEqual(ledger.find(entry => entry.id === 2)!.statuses, ['speculative', 'working', 'answering', 'interrupted', 'answering', 'answered']);
  assert.equal(ledger.find(entry => entry.id === 3)!.topic, 'recent commits');
  const stats = conversationStats([events]);
  assert.deepEqual({ questions: stats.questions, answered: stats.answered, cancelled: stats.cancelled, unresolved: stats.unresolved,
    earlyAdopted: stats.earlyAdopted, earlyRolledBack: stats.earlyRolledBack, cutOff: stats.cutOff, resumed: stats.resumed,
    askedAgain: stats.askedAgain, spokeOverPeople: stats.spokeOverPeople, duplicateWrites: stats.duplicateWrites, completion: stats.completion },
  { questions: 3, answered: 1, cancelled: 1, unresolved: 1, earlyAdopted: 1, earlyRolledBack: 1, cutOff: 1, resumed: 1,
    askedAgain: 1, spokeOverPeople: 1, duplicateWrites: 1, completion: 0.5 });
});

test('machine tells: what gives her away as a bot in what she said aloud', () => {
  assert.deepEqual(machineTells(['Yep, it lives in server.ts.'], 'Roee'), []);
  assert.deepEqual(machineTells(['Certainly! The main file is src/app/server.ts.'], 'Roee'), ['chatbot phrase', 'reads a file path aloud']);
  assert.deepEqual(machineTells(['Roee wants a task to add caching.'], 'Roee'), ['talks about the speaker in the third person']);
  assert.deepEqual(machineTells(['Follow-up questions without my name don\'t activate me.'], 'Roee'), ['explains her own mechanics']);
  assert.deepEqual(machineTells(["I'll look at the attendee lifecycle and command router to walk you through it accurately."], 'Roee'), ['narrates her plan']);
  assert.deepEqual(machineTells(['The usual fix is to back off and reduce request volume or'], 'Roee'), ['stops mid-sentence']);
  // Seen in the 2026-10-31 baselines while "sounded human" still read 12/12.
  assert.deepEqual(machineTells(["Avi is addressing Roy, not me, so I'll stay quiet on this one."], 'Dana'), ['reasons aloud']);
  assert.deepEqual(machineTells(['Nogita speaks only when someone addresses it by name.'], 'Roee'), ['calls herself Nogita']);
});

test('a transcript arriving after the next speaker starts stays with the speaker who said it', () => {
  const first: Turn = { speaker: 'roee', say: 'Nogita, what changed?', expect: { respond: 'speak' } };
  const second: Turn = { speaker: 'dana', say: 'Let us discuss the launch.', expect: { respond: 'silent' } };
  const events = [
    { t: 100, type: 'speech_start' as const, participant: 'roee' },
    { t: 200, type: 'speech_end' as const, participant: 'roee' },
    { t: 250, type: 'speech_start' as const, participant: 'roee' },
    { t: 300, type: 'stt_final' as const, participant: 'lab_roee', text: 'Nogita, what changed?' },
    { t: 310, type: 'utterance' as const, participant: 'lab_roee', text: 'Nogita, what changed?' },
    { t: 400, type: 'speech_end' as const, participant: 'roee' },
    { t: 450, type: 'stt_final' as const, participant: 'lab_roee', text: 'Let us discuss the launch.' },
    { t: 460, type: 'utterance' as const, participant: 'lab_roee', text: 'Let us discuss the launch.' },
  ];

  const result = recordEvents(events, first, 0, { start: 100, end: 200 }, 250, 'roee', { next: second });
  const nextResult = recordEvents(events, second, 1, { start: 250, end: 400 }, undefined, 'roee', { previous: first });

  assert.equal(result.heard, 'Nogita, what changed?');
  assert.equal(result.timing.sttFinal, 100);
  assert.equal(result.timing.utterance, 110);
  assert.equal(nextResult.heard, 'Let us discuss the launch.');
});

test('two-speed scenarios ask a research question and then keep talking, with timing for both answers', () => {
  const scenarios = SCENARIOS.filter(scenario => scenario.twoSpeed);
  assert.deepEqual(scenarios.map(scenario => scenario.name), ['two-speed', 'two-speed-busy-room']);
  for (const scenario of scenarios) {
    const [ask, ...rest] = scenario.turns;
    assert.ok(ask!.expect.contentWithinMs && ask!.expect.fullAnswerWithinMs, scenario.name);
    assert.ok(rest.length >= 3 && rest.every(turn => turn.expect.respond === 'silent'), scenario.name);
  }
  assert.equal(scenarios[0]!.turns[0]!.expect.fullAnswerSpoken, 'spoken');
  assert.equal(scenarios[1]!.turns[0]!.expect.fullAnswerSpoken, 'any');
});

/** Roee asks at 0-1000; the short line at 1500; Dana talks 3000-5000; the full answer lands in chat at 4000 and is
 *  spoken at `spokenAt` (or not at all). */
function twoSpeedEvents(spokenAt?: number) {
  const events = [
    { t: 0, type: 'speech_start' as const, participant: 'roee' },
    { t: 1_000, type: 'speech_end' as const, participant: 'roee' },
    { t: 1_100, type: 'utterance' as const, participant: 'lab_roee', text: 'Nogita, what landed in the repo today?' },
    { t: 1_150, type: 'question' as const, participant: 'lab_roee', questionId: 1, detail: '#1 working' },
    { t: 1_500, type: 'speak_call' as const, questionId: 1, text: "Checking today's commits." },
    { t: 1_600, type: 'audio_start' as const },
    { t: 2_400, type: 'question' as const, participant: 'lab_roee', questionId: 1, detail: '#1 answered: short answer; M-AB12 researches the full answer' },
    { t: 3_000, type: 'speech_start' as const, participant: 'dana' },
    { t: 4_000, type: 'chat' as const, text: "About today's commits: 40 commits and 16 pull requests, mostly turn taking." },
    { t: 5_000, type: 'speech_end' as const, participant: 'dana' },
    { t: 5_200, type: 'utterance' as const, participant: 'lab_dana', text: 'While she looks, did the design review move?' },
  ];
  if (spokenAt !== undefined) events.push(
    { t: spokenAt, type: 'speak_call' as const, questionId: 1, text: "About today's commits, 40 commits and 16 pull requests." },
    { t: spokenAt + 5, type: 'chat' as const, text: "About today's commits, 40 commits and 16 pull requests." },
    { t: spokenAt + 50, type: 'audio_start' as const });
  return events.sort((a, b) => a.t - b.t);
}

test('the full answer is timed on the question that asked it, and is not counted as speech in the next turn', () => {
  const [ask, chatter] = SCENARIOS.find(scenario => scenario.name === 'two-speed')!.turns;
  const events = twoSpeedEvents(6_000);
  const asked = recordEvents(events, ask!, 0, { start: 0, end: 1_000 }, 3_000, 'roee');
  assert.deepEqual(asked.fullAnswer, { at: 3_000, spokenAt: 5_050, overPeople: false });
  assert.deepEqual(asked.spoken, ["Checking today's commits."]);
  const failed = scoreTurn({ ...asked, heard: 'Nogita, what landed in the repo today?', tools: ['repo_activity: today'] })
    .checks.filter(check => !check.ok).map(check => check.name);
  assert.deepEqual(failed, []);
  const next = recordEvents(events, chatter!, 1, { start: 3_000, end: 5_000 }, undefined, 'dana');
  assert.deepEqual([next.spoken, next.chat, next.fullAnswer], [[], [], undefined]);
  assert.equal(scoreTurn({ ...next, heard: 'While she looks' }).passed, true);
});

test('a full answer started while someone talks fails; one left in chat passes only where chat is allowed', () => {
  const [ask] = SCENARIOS.find(scenario => scenario.name === 'two-speed')!.turns;
  const [busyAsk] = SCENARIOS.find(scenario => scenario.name === 'two-speed-busy-room')!.turns;
  const fails = (turn: Turn, events: ReturnType<typeof twoSpeedEvents>) => scoreTurn({
    ...recordEvents(events, turn, 0, { start: 0, end: 1_000 }, 3_000, 'roee'), heard: 'Nogita, a research question?', tools: ['repo_activity: today'] })
    .checks.filter(check => !check.ok).map(check => check.name);
  // Over Dana, who has been talking since 3000.
  assert.deepEqual(fails(ask!, twoSpeedEvents(4_200)), ['full answer not over people']);
  assert.deepEqual(fails(ask!, twoSpeedEvents()), ['full answer spoken']);
  assert.deepEqual(fails(busyAsk!, twoSpeedEvents()), []);
  // No full answer at all.
  assert.deepEqual(fails(busyAsk!, twoSpeedEvents().filter(event => event.type !== 'chat')), ['full answer within 90 s']);
});
