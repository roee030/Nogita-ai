import assert from 'node:assert/strict';
import test from 'node:test';
import { SlackMissionHandoffs } from '../src/app/slack-conversations.ts';
import { dispatchSlackMissionReply } from '../src/app/slack-socket-events.ts';

test('a meeting mission update is delivered to its bound Slack thread', async () => {
  const handoffs = new SlackMissionHandoffs(true);
  handoffs.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C1:171.001', channel: 'C1', threadTs: '171.001' });
  const sent: Array<{ channel: string; threadTs: string; text: string }> = [];

  const delivered = await handoffs.deliver('M-7ABC', 'M-7ABC done: fixed KAN-20', async (channel, threadTs, text) => {
    sent.push({ channel, threadTs, text });
  });

  assert.equal(delivered, true);
  assert.deepEqual(sent, [{ channel: 'C1', threadTs: '171.001', text: 'M-7ABC done: fixed KAN-20' }]);
});

test('a reply in the handoff thread is routed to the same mission', async () => {
  const handoffs = new SlackMissionHandoffs(true);
  handoffs.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C1:171.001', channel: 'C1', threadTs: '171.001' });
  const replies: Array<{ missionId: string; actorId: string; text: string }> = [];

  const routed = await dispatchSlackMissionReply({ sessionId: 'slack:T1:C1:171.001',
    utterance: { eventId: 'Ev2', actor: { id: 'roee', displayName: 'Roee', verified: true }, text: 'continue with the fix' } },
  handoffs, async (missionId, utterance) => {
    replies.push({ missionId, actorId: utterance.actor.id, text: utterance.text });
  });

  assert.equal(routed, true);
  assert.deepEqual(replies, [{ missionId: 'M-7ABC', actorId: 'roee', text: 'continue with the fix' }]);
});

test('handoff behavior is off by default and unrelated threads stay on the normal Slack path', async () => {
  const disabled = new SlackMissionHandoffs();
  assert.equal(disabled.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C1:171.001', channel: 'C1', threadTs: '171.001' }), false);
  assert.equal(await disabled.deliver('M-7ABC', 'secret', async () => assert.fail('must not post')), false);

  const enabled = new SlackMissionHandoffs(true);
  let called = false;
  const routed = await dispatchSlackMissionReply({ sessionId: 'slack:T1:C9:999.9',
    utterance: { eventId: 'Ev3', actor: { id: 'roee', displayName: 'Roee', verified: true }, text: 'hello' } },
  enabled, async () => { called = true; });
  assert.equal(routed, false);
  assert.equal(called, false);
});

test('moving a mission to another Slack thread removes the stale route', () => {
  const handoffs = new SlackMissionHandoffs(true);
  handoffs.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C1:171.001', channel: 'C1', threadTs: '171.001' });
  handoffs.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C2:172.002', channel: 'C2', threadTs: '172.002' });

  assert.equal(handoffs.missionForThread('slack:T1:C1:171.001'), undefined);
  assert.equal(handoffs.missionForThread('slack:T1:C2:172.002'), 'M-7ABC');
});

test('an unmapped Slack user cannot send guidance into a meeting mission', async () => {
  const handoffs = new SlackMissionHandoffs(true);
  handoffs.bind({ missionId: 'M-7ABC', meetingSessionId: 'meet:daily',
    slackSessionId: 'slack:T1:C1:171.001', channel: 'C1', threadTs: '171.001' });
  let called = false;

  const routed = await dispatchSlackMissionReply({ sessionId: 'slack:T1:C1:171.001',
    utterance: { eventId: 'Ev4', actor: { id: 'unmapped:slack:T1:U9', displayName: 'Slack user U9', verified: false },
      text: 'approve it' } }, handoffs, async () => { called = true; });

  assert.equal(routed, false);
  assert.equal(called, false);
});
