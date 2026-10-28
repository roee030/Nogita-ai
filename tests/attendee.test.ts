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
  const meeting = new AttendeeMeeting('session', 'test-token', true, mock, 'https://nogita.example/webhooks/attendee');
  assert.equal(await meeting.raiseHand(), false);
  assert.equal(calls.length, 0);
  await meeting.join(meetingUrl);
  assert.equal(meeting.botIdentifier, bot.id);
  await assert.rejects(() => meeting.join(meetingUrl), /already joining/);
  await meeting.speak('Hello.');
  await meeting.sendCompletion({ provider: 'jira', kind: 'task', label: 'NG-1', url: 'https://example.atlassian.net/browse/NG-1' });
  await meeting.leave();
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), [
    '/api/v1/bots', '/api/v1/bots/bot_weIAju4OXNZkDTpZ/send_chat_message',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/speech',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/send_chat_message',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/leave'
  ]);
  assert.ok(calls.every(x => x.auth === 'Token test-token'));
  assert.equal(calls[0]?.payload.debug_settings.create_debug_recording, false);
  assert.deepEqual(calls[0]?.payload.automatic_leave_settings, {
    silence_timeout_seconds: 180,
    only_participant_in_meeting_timeout_seconds: 30,
  });
  assert.deepEqual(calls[0]?.payload.metadata, { session_id: 'session' });
  assert.equal(calls[0]?.payload.bot_metadata, undefined);
  assert.deepEqual(calls[0]?.payload.webhooks, [{
    url: 'https://nogita.example/webhooks/attendee',
    triggers: ['bot.state_change', 'transcript.update', 'participant_events.join_leave'],
  }]);
  assert.deepEqual(calls[1]?.payload, { to: 'everyone', message: 'Hello.' });
  assert.equal(calls[2]?.payload.text, 'Hello.');
  assert.deepEqual(calls[3]?.payload, { to: 'everyone', message: 'NG-1: https://example.atlassian.net/browse/NG-1' });
});

test('Attendee: verification prompt is queued for delivery after the bot joins', async () => {
  let createPayload: any;
  const mock: typeof fetch = async (_url, options) => {
    createPayload = JSON.parse(String(options?.body));
    return new Response(JSON.stringify(bot), { status: 201 });
  };
  const meeting = new AttendeeMeeting('session', 'test-token', true, mock,
    'https://nogita.example/webhooks/attendee', 'To verify, say: Nogita verify 123456');

  await meeting.join(meetingUrl);

  assert.deepEqual(createPayload.bot_chat_message, {
    to: 'everyone',
    message: 'To verify, say: Nogita verify 123456',
  });
});

test('Attendee: local speech is uploaded as MP3 audio instead of relying on provider TTS', async () => {
  const calls: Array<{ path: string; payload: any }> = [];
  const mock: typeof fetch = async (url, options) => {
    calls.push({ path: new URL(String(url)).pathname,
      payload: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (String(url).endsWith('/api/v1/bots')) return new Response(JSON.stringify(bot), { status: 201 });
    return new Response(null, { status: 200 });
  };
  const meeting = new AttendeeMeeting('session', 'test-token', true, mock, undefined, undefined,
    async text => Buffer.from(`mp3:${text}`));

  await meeting.join(meetingUrl);
  await meeting.speak('Hello from Nogita.');

  assert.deepEqual(calls.map(call => call.path), [
    '/api/v1/bots',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/send_chat_message',
    '/api/v1/bots/bot_weIAju4OXNZkDTpZ/output_audio',
  ]);
  assert.deepEqual(calls[2]?.payload, {
    type: 'audio/mp3', data: Buffer.from('mp3:Hello from Nogita.').toString('base64'),
  });
});

test('Attendee realtime mode requests per-participant PCM and routes output through the stream', async () => {
  const calls: Array<{ path: string; payload: any }> = [];
  const mock: typeof fetch = async (url, options) => {
    calls.push({ path: new URL(String(url)).pathname,
      payload: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (String(url).endsWith('/api/v1/bots')) return new Response(JSON.stringify(bot), { status: 201 });
    return new Response(null, { status: 204 });
  };
  const spoken: string[] = [];
  const meeting = new AttendeeMeeting('realtime-session', 'test-token', true, mock, undefined, undefined,
    async () => { throw new Error('legacy synthesis must not be selected'); }, undefined,
    'wss://nogita.example/webhooks/attendee/audio?session_id=signed', async text => { spoken.push(text); });
  await meeting.join(meetingUrl);
  await meeting.speak('Hello over PCM');
  assert.deepEqual(calls[0]?.payload.websocket_settings, { per_participant_audio: {
    url: 'wss://nogita.example/webhooks/attendee/audio?session_id=signed', sample_rate: 16000,
  } });
  assert.deepEqual(spoken, ['Hello over PCM']);
  assert.deepEqual(calls.map(call => call.path), [
    '/api/v1/bots', '/api/v1/bots/bot_weIAju4OXNZkDTpZ/send_chat_message',
  ]);
});

test('Attendee: reports only numeric speech stage timings for local TTS flow', async () => {
  const stages: Array<{ stage: string; durationMs: number }> = [];
  const mock: typeof fetch = async () => new Response(null, { status: 204 });
  const meeting = new AttendeeMeeting('timed-session', 'test-token', true, mock, undefined, undefined,
    async () => Buffer.from('mp3'), (stage, durationMs) => stages.push({ stage, durationMs }));
  meeting.attach('bot_timing123');
  await meeting.speak('A private sentence that must not enter metrics.');

  assert.deepEqual(stages.map(item => item.stage).sort(),
    ['audio_submission', 'chat_mirror', 'speech_submission', 'tts_synthesis'].sort());
  assert.ok(stages.every(item => Number.isFinite(item.durationMs) && item.durationMs >= 0));
  assert.equal(JSON.stringify(stages).includes('private sentence'), false);
});

test('Attendee: failed synthesis still records elapsed stages without reporting audio submission', async () => {
  const stages: string[] = [];
  const mock: typeof fetch = async () => new Response(null, { status: 204 });
  const meeting = new AttendeeMeeting('timed-failure', 'test-token', true, mock, undefined, undefined,
    async () => { throw new Error('private provider detail'); }, stage => stages.push(stage));
  meeting.attach('bot_timing123');

  await assert.rejects(() => meeting.speak('Hello.'), /speech unavailable after chat fallback/);
  assert.deepEqual(stages.sort(), ['chat_mirror', 'speech_submission', 'tts_synthesis'].sort());
});

test('Attendee: restored bot can speak without creating a replacement bot', async () => {
  const paths: string[] = [];
  const mock: typeof fetch = async url => {
    paths.push(new URL(String(url)).pathname);
    return new Response(null, { status: 204 });
  };
  const meeting = new AttendeeMeeting('restored-session', 'test-token', true, mock,
    'https://nogita.example/webhooks/attendee');
  meeting.attach('bot_restored123');
  await meeting.speak('Back online.');
  assert.deepEqual(paths, [
    '/api/v1/bots/bot_restored123/send_chat_message',
    '/api/v1/bots/bot_restored123/speech',
  ]);
  assert.throws(() => meeting.attach('bot_second'), /already joining/);
  assert.throws(() => new AttendeeMeeting('s', 'key', true, mock).attach('../bad'), /valid ID/);
});

test('Attendee: failed leave retains the bot ID so leave can be retried', async () => {
  let attempts = 0;
  const mock: typeof fetch = async () => {
    attempts++;
    return attempts === 1 ? new Response('{}', { status: 503 }) : new Response(null, { status: 204 });
  };
  const meeting = new AttendeeMeeting('retry-session', 'test-token', true, mock);
  meeting.attach('bot_retry123');
  await assert.rejects(() => meeting.leave(), /HTTP 503/);
  assert.equal(meeting.botIdentifier, 'bot_retry123');
  await meeting.leave();
  assert.equal(meeting.botIdentifier, undefined);
  assert.equal(attempts, 2);
});
