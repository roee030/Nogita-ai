import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AttendeeCommandRouter } from '../src/app/attendee-command-router.ts';
import { createDependencies } from '../src/app/config.ts';
import { directlyAddressesNogita, normalizeWakeWord } from '../src/core/policy.ts';
import { FRAME_SAMPLES, SAMPLE_RATE, floatToPcm, msToSamples, pcmToFloat, rms, wav } from '../tools/voice-lab/audio.ts';
import { playScenario, type TurnRecord } from '../tools/voice-lab/conversation.ts';
import { SPEECH_RMS, createNoise } from '../tools/voice-lab/noise.ts';
import { VoiceRig } from '../tools/voice-lab/rig.ts';
import { SCENARIOS, type Scenario, type Turn } from '../tools/voice-lab/scenarios.ts';
import { scoreTurn, stats, wordErrorRate } from '../tools/voice-lab/score.ts';
import { transcriptLines, transcriptMarkdown } from '../tools/voice-lab/report.ts';
import { conversationStats, questionLedger } from '../tools/voice-lab/conversation-metrics.ts';

test('speech recognition variants of the wake word are restored only where someone addresses Nogita', () => {
  for (const [heard, expected] of [
    ['Nokita. How do you verify speakers?', 'Nogita. How do you verify speakers?'],
    ['No Gita, what is this project?', 'Nogita, what is this project?'],
    ['So for the retry. Notita, what happens when Jira is down?', 'So for the retry. Nogita, what happens when Jira is down?'],
    ['Hey, Nikita, can you check?', 'Hey, Nogita, can you check?'],
    ['Lokita, what are the open tasks?', 'Nogita, what are the open tasks?'],
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

test('every built-in scenario names its own participants and a known noise kind', () => {
  for (const scenario of SCENARIOS) {
    const ids = new Set(scenario.participants.map(p => p.id));
    for (const turn of scenario.turns) assert.ok(ids.has(turn.speaker), `${scenario.name}: ${turn.speaker}`);
    assert.ok(scenario.participants.every(p => p.voice !== 'aura-2-thalia-en'), 'participants never use Nogita\'s voice');
  }
});

function record(turn: Turn, fields: Partial<TurnRecord>): TurnRecord {
  return { index: 0, turn, script: String(turn.say), heard: String(turn.say), spoken: [], chat: [], writes: [], tools: [], spokeAfterUtterance: 0,
    interruptedByNoise: false, handRaisedBefore: false, events: [], timing: { speechStart: 0, speechEnd: 0 }, ...fields };
}

test('scoring checks hearing, silence, required phrases, writes and interruptions', () => {
  assert.equal(wordErrorRate('Nogita what is this', 'Nokita what is this'), 0.25);
  assert.equal(wordErrorRate('a b', ''), 1);
  const ask: Turn = { speaker: 'roee', say: 'Nogita, what is the capital of Australia?',
    expect: { respond: 'speak', mentions: [['canberra']], write: 'none' } };
  const good = scoreTurn(record(ask, { spoken: ['Canberra.'], timing: { speechStart: 0, speechEnd: 0, firstAudio: 900 } }));
  assert.equal(good.passed, true);
  assert.equal(good.addressHeard, true);
  const misheard = scoreTurn(record(ask, { heard: 'Nokita what is the capital of Australia', spoken: [] }));
  assert.deepEqual(misheard.checks.filter(c => !c.ok).map(c => c.name), ['name heard', 'answered aloud', 'mentions canberra']);
  const quiet: Turn = { speaker: 'dana', say: 'Let us move on.', expect: { respond: 'silent' } };
  assert.equal(scoreTurn(record(quiet, { chat: ['I heard you.'] })).passed, false);
  assert.equal(scoreTurn(record(quiet, {})).passed, true);
  const wrote = scoreTurn(record(ask, { spoken: ['Canberra.'], writes: ['task: x'], interruptedByNoise: true,
    timing: { speechStart: 0, speechEnd: 0, firstAudio: 1 } }));
  assert.deepEqual(wrote.checks.filter(c => !c.ok).map(c => c.name), ['no write', 'not cut off']);
  assert.deepEqual(stats([3, 1, undefined, 2]), { count: 3, mean: 2, p50: 2, p90: 3, min: 1, max: 3 });
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
    { t: 8_000, type: 'speech_start' as const, participant: 'avi' }, { t: 8_900, type: 'audio_start' as const },
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
