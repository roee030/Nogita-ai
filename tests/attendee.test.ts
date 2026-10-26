import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendeeMeeting } from '../src/adapters/attendee.ts';

const bot = { id: 'bot_weIAju4OXNZkDTpZ' };
const meetingUrl = 'https://meet.google.com/abc-defg-hij';
test('Attendee: privacy review and approved host required before API call', async () => {
  let calls = 0;
  const mock: typeof fetch = async () => { calls++; return new Response(JSON.stringify(bot), { status: 201 }); };
  const unreviewed = new AttendeeMeeting('session', 'test', false, mock);
  await assert.rejects(() => unreviewed.join(meetingUrl), /retention has not been reviewed/);
  const approved = new AttendeeMeeting('session', 'test', true, mock);
  await assert.rejects(() => approved.join('https://meet.google.com.evil.test/call'), /allowlist/);
  assert.equal(calls, 0);
});
test('Attendee: join, English speech, receipt and leave hit documented paths', async () => {
  const calls: Array<{url: string; method: string; payload: any; auth: string|null}> = [];
  const mock: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), method: String(options?.method), payload: options?.body ? JSON.parse(String(options.body)) : undefined,
      auth: new Headers(options?.headers).get('Authorization') });
    if (String(url).endsWith('/api/v1/bots')) return new Response(JSON.stringify(bot), { status: 201 });
    return new Response(null, { status: 204 });
  };
  const meeting = new AttendeeMeeting('session', 'test-token', true, mock);
  assert.equal(await meeting.raiseHand(), false);
  assert.equal(calls.length, 0);
  await meeting.join(meetingUrl);
  await assert.rejects(() => meeting.join(meetingUrl), /already joining/);
  await meeting.speak('Hello.');
  await meeting.sendCompletion({ provider: 'jira', kind: 'task', label: 'NG-1', url: 'https://example.atlassian.net/browse/NG-1' });
  await meeting.leave();
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), [
    '/api/v1/bots', '/api/v1/bots/bot_weIAju4OXNZkDTpZ/speech',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/send_chat_message',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/leave'
  ]);
  assert.ok(calls.every(x => x.auth === 'Token test-token'));
  assert.equal(calls[0]?.payload.debug_settings.create_debug_recording, false);
  assert.equal(calls[1]?.payload.text, 'Hello.');
  assert.deepEqual(calls[2]?.payload, { to: 'everyone', message: 'NG-1: https://example.atlassian.net/browse/NG-1' });
});
