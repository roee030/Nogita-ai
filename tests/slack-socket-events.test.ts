import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSlackEventHandlers } from '../src/app/slack-socket-events.ts';

test('registers handlers for the inner Slack event types emitted by SocketModeClient', () => {
  const registered: string[] = [];
  const client = { on: (event: string) => { registered.push(event); } };

  registerSlackEventHandlers(client, () => undefined);

  assert.deepEqual(registered, ['app_mention', 'message']);
});
