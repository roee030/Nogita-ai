import { SocketModeClient } from '@slack/socket-mode';
import { NogitaEngine } from '../core/engine.ts';
import { SlackThreadMeeting } from '../adapters/slack.ts';
import { parseSlackRequest, type SlackEnvelope } from './slack-event.ts';
import { registerSlackEventHandlers } from './slack-socket-events.ts';
import { createDependencies, loadDotEnv } from './config.ts';

loadDotEnv();
const token = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const teams = new Set((process.env.SLACK_ALLOWED_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
if (!token?.startsWith('xoxb-') || !appToken?.startsWith('xapp-') || !teams.size) {
  throw new Error('SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_ALLOWED_TEAM_IDS are required');
}
const dependencies = createDependencies();
const engine = new NogitaEngine(dependencies);
const client = new SocketModeClient({ appToken });
const sessions = new Set<string>();
const seen = new Set<string>();

registerSlackEventHandlers(client, async ({ body, ack }) => {
  // Acknowledge promptly; processing may include slow model and tool calls.
  await ack();
  const request = parseSlackRequest(body as SlackEnvelope, teams, process.env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || seen.has(request.utterance.eventId)) return;
  seen.add(request.utterance.eventId);
  if (seen.size > 2000) seen.delete(seen.values().next().value!);
  try {
    if (!sessions.has(request.sessionId)) {
      await engine.startSession(request.sessionId,
        new SlackThreadMeeting(request.sessionId, token, request.channel, request.threadTs));
      sessions.add(request.sessionId);
    }
    await engine.onUtterance(request.sessionId, request.utterance);
  } catch (err) {
    console.error('slack_event_failed', err instanceof Error ? err.message : 'unknown');
  }
});
await client.start();
console.log('Nogita Slack Socket Mode is connected. Mention @Nogita in an invited channel or DM "Nogita, hello".');
