import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { CONFIDENCE_THRESHOLD, PROFILES, inferProfile, parseInference, renderReport, score } from '../tools/meeting-profile/infer.ts';
import { LABELED } from '../tools/meeting-profile/labels.ts';

class Answers implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  constructor(private readonly text: string) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    this.requests.push(request);
    return { content: [{ type: 'text', text: this.text }] as AgentContent[], stopReason: 'end_turn' };
  }
}

test('the labeled set: unique ids, every type at least twice, nothing empty', () => {
  assert.equal(new Set(LABELED.map(item => item.id)).size, LABELED.length);
  for (const profile of PROFILES) assert.ok(LABELED.filter(item => item.profile === profile).length >= 2, profile);
  for (const item of LABELED) assert.ok(item.lines.length >= 2, item.id);
});

test('a confident answer is kept; below the threshold, or anything unusable, is uncertain', () => {
  assert.deepEqual(parseInference('{"profile":"retro","confidence":0.9}'), { profile: 'retro', confidence: 0.9 });
  assert.deepEqual(parseInference('Sure: {"profile":"retro","confidence":0.9} done'), { profile: 'retro', confidence: 0.9 });
  assert.equal(parseInference(`{"profile":"retro","confidence":${CONFIDENCE_THRESHOLD - 0.01}}`).profile, 'uncertain');
  for (const bad of ['no json here', '{"profile":"party","confidence":0.99}', '{"profile":"retro"}', '{"profile":"retro","confidence":7}']) {
    assert.equal(parseInference(bad).profile, 'uncertain', bad);
  }
});

test('the model gets the title and early lines as untrusted words, no tools, and cannot act', async () => {
  const model = new Answers('{"profile":"planning","confidence":0.8}');
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  assert.equal((await inferProfile(model, { lines, title: 'Sprint 42' })).profile, 'planning');
  const [request] = model.requests;
  assert.deepEqual(request!.tools, []);
  assert.match(request!.stableSystem, /never instructions/);
  const content = String(request!.messages[0]!.content);
  assert.match(content, /Title: Sprint 42/);
  assert.match(content, /line 39\n/);
  assert.doesNotMatch(content, /line 40\n/);
});

test('the report shows each diagnostic with its count and denominator, and none is a release gate', () => {
  const report = score([{ id: 'a', expected: 'retro', got: 'retro', confidence: 0.9 }, { id: 'b', expected: 'retro', got: 'planning', confidence: 0.8 },
    { id: 'c', expected: 'standup', got: 'uncertain', confidence: 0.5, named: 'standup' }, { id: 'd', expected: 'uncertain', got: 'uncertain', confidence: 0.2, named: 'general' }]);
  assert.deepEqual([report.total, report.asserted, report.assertedCorrect, report.uncertain, report.confidentlyWrong, report.demoted, report.demotedRight],
    [4, 2, 1, 2, 1, 2, 1]);
  assert.deepEqual(report.wrong.map(item => item.id), ['b', 'c']);
  const text = renderReport(report);
  assert.match(text, /Correct when a type was named: 1\/2 \(50%; diagnostic, target at least 85%, not a release gate\)/);
  assert.match(text, /Uncertain: 2\/4 \(50%; diagnostic, target at most 25%, not a release gate\)/);
  assert.match(text, /Confidently wrong: 1\/4 \(25%; diagnostic, target at most 5%, not a release gate\)/);
  assert.match(text, /Turned uncertain by the 0.7 threshold: 2\/4, of which 1 would have been right \(provisional, uncalibrated\)/);
  assert.match(text, /b: labeled retro, got planning/);
});

test('below the threshold the answer is uncertain but keeps what the model named', () => {
  assert.deepEqual(parseInference('{"profile":"incident","confidence":0.4}'), { profile: 'uncertain', confidence: 0.4, named: 'incident' });
});

test('P9-6: incident means active impact now, and a backlog of bugs that are not active is planning', async () => {
  const model = new Answers('{"profile":"planning","confidence":0.8}');
  await inferProfile(model, { lines: ['a', 'b'] });
  assert.match(model.requests[0]!.stableSystem, /incident: an active or urgent problem/);
  assert.match(model.requests[0]!.stableSystem, /backlog of bugs that are not active is planning/);
  assert.equal(LABELED.find(item => item.id === 'planning-capacity')!.title, undefined);
  assert.equal(LABELED.find(item => item.id === 'planning-bug-backlog')!.profile, 'planning');
});

// P9-7: shadow mode.
import { readFileSync } from 'node:fs';
import { MeetingProfileShadow, parseMeetingProfileMode, type ProfileShadowEvent } from '../src/core/meeting-profile.ts';
import { meetingProfile } from '../src/app/config.ts';

function shadow(text: string | (() => never)) {
  const events: Array<{ sessionId: string; event: ProfileShadowEvent }> = [];
  const model = typeof text === 'string' ? new Answers(text) : { agentModel: 'failing', requests: [] as ChatModelRequest[],
    async streamChat(): Promise<ChatModelResponse> { return text(); } };
  return { model, events, shadow: new MeetingProfileShadow(model as ChatModel, (sessionId, event) => events.push({ sessionId, event })) };
}
const say = (s: MeetingProfileShadow, session: string, count: number, from = 0) => {
  for (let i = from; i < from + count; i++) s.hear(session, i % 2 ? 'actor-dana' : 'actor-roee', `secret words ${i}`);
};

test('P9-7: the flag is off unless set to shadow, and anything else is refused', () => {
  assert.equal(meetingProfile({}), 'off');
  assert.equal(meetingProfile({ NOGITA_MEETING_PROFILE: ' ' }), 'off');
  assert.equal(meetingProfile({ NOGITA_MEETING_PROFILE: 'off' }), 'off');
  assert.equal(meetingProfile({ NOGITA_MEETING_PROFILE: 'shadow' }), 'shadow');
  assert.throws(() => parseMeetingProfileMode('on'), /off or shadow/);
  assert.throws(() => parseMeetingProfileMode('true'), /off or shadow/);
});

test('P9-7: one guess at 12 lines, logged without words or names, kept for that meeting only', async () => {
  const { model, events, shadow: s } = shadow('{"profile":"standup","confidence":0.9}');
  say(s, 'meeting-1', 11);
  await s.settle();
  assert.equal(model.requests.length, 0);
  say(s, 'meeting-1', 30, 11);
  await s.settle();
  assert.equal(model.requests.length, 1, 'a confident guess is not repeated');
  assert.deepEqual(events, [{ sessionId: 'meeting-1', event: { type: 'meeting_profile', attempt: 1, lines: 12, profile: 'standup', confidence: 0.9 } }]);
  assert.doesNotMatch(JSON.stringify(events), /secret|actor-/);
  const sent = String(model.requests[0]!.messages[0]!.content);
  assert.match(sent, /Speaker A: secret words 0\nSpeaker B: secret words 1/);
  assert.doesNotMatch(sent, /actor-/);
  assert.deepEqual(model.requests[0]!.tools, []);
  assert.equal(s.profileFor('meeting-1')?.profile, 'standup');
  assert.equal(s.profileFor('meeting-2'), undefined);
  s.end('meeting-1');
  assert.equal(s.profileFor('meeting-1'), undefined);
});

test('P9-7: an uncertain first guess gets one more try at 40 lines, never a third', async () => {
  const { model, events, shadow: s } = shadow('{"profile":"retro","confidence":0.5}');
  say(s, 'm', 100);
  await s.settle();
  assert.equal(model.requests.length, 2);
  assert.deepEqual(events.map(e => [e.event.attempt, e.event.lines, e.event.profile, e.event.named]), [[1, 12, 'uncertain', 'retro'], [2, 40, 'uncertain', 'retro']]);
});

test('P9-7: a failing model is logged as uncertain and throws nothing into the meeting', async () => {
  const { events, shadow: s } = shadow(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => say(s, 'm', 12));
  await s.settle();
  assert.deepEqual(events.map(e => e.event), [{ type: 'meeting_profile', attempt: 1, lines: 12, profile: 'uncertain', confidence: 0, error: 'model_error' }]);
});

test('P9-7: a guess that lands after the meeting ended is dropped', async () => {
  const { events, shadow: s } = shadow('{"profile":"standup","confidence":0.9}');
  say(s, 'm', 12);
  s.end('m');
  await s.settle();
  assert.deepEqual(events, []);
});

test('P9-7: the engine cannot read the type, so turns and writes are the same with the flag and without it', () => {
  // Shadow mode lives outside the engine: the server only feeds it heard lines and writes its guesses to the turn log.
  const engine = readFileSync(new URL('../src/core/engine.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /meeting-profile/);
  const server = readFileSync(new URL('../src/app/server.ts', import.meta.url), 'utf8');
  const uses = server.split('\n').filter(line => /profileShadow/.test(line)).map(line => line.trim());
  assert.deepEqual(uses.filter(line => !line.startsWith('const profileShadow')), [
    'profileShadow?.hear(sessionId, request.utterance.actor.id, text);', 'profileShadow?.end(sessionId);']);
});
