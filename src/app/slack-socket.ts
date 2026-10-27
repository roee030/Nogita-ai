import { SocketModeClient } from '@slack/socket-mode';
import { NogitaEngine } from '../core/engine.ts';
import { SlackThreadMeeting } from '../adapters/slack.ts';
import { parseSlackRequest, type SlackEnvelope } from './slack-event.ts';
import { registerSlackEventHandlers } from './slack-socket-events.ts';
import { createDependencies, loadDotEnv } from './config.ts';
import { FileEventLedger } from './event-ledger.ts';
import { runClaimedEvent } from './claimed-event.ts';
import { InFlightWork } from './in-flight.ts';
import { EncryptedFileEventQueue } from './durable-event-queue.ts';
import { EventWorker } from './event-worker.ts';

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
const slackLedger = new FileEventLedger(process.env.NOGITA_STATE_DIR ?? '.nogita-state');
const inFlight = new InFlightWork();
const queue = process.env.NOGITA_QUEUE_ENCRYPTION_KEY
  ? new EncryptedFileEventQueue(process.env.NOGITA_STATE_DIR ?? '.nogita-state', process.env.NOGITA_QUEUE_ENCRYPTION_KEY)
  : undefined;

async function processBody(raw: string): Promise<void> {
  const body = JSON.parse(raw) as SlackEnvelope;
  const request = parseSlackRequest(body, teams, process.env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || !inFlight.accepting) return;
  const work = runClaimedEvent(slackLedger, 'slack', request.utterance.eventId, async () => {
    if (!sessions.has(request.sessionId)) {
      await engine.startSession(request.sessionId,
        new SlackThreadMeeting(request.sessionId, token!, request.channel, request.threadTs));
      sessions.add(request.sessionId);
    }
    await engine.onUtterance(request.sessionId, request.utterance);
  }).then(() => undefined);
  inFlight.track(work);
  await work;
}

const queueWorker = queue ? new EventWorker(queue, async item => {
  if (item.namespace === 'slack') await processBody(item.payload);
}, { concurrency: 4, onError: error => console.error('slack_event_failed',
  error instanceof Error ? error.message : 'unknown') }) : undefined;
queueWorker?.start();

registerSlackEventHandlers(client, async ({ body, ack }) => {
  const request = parseSlackRequest(body as SlackEnvelope, teams, process.env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || !inFlight.accepting) { await ack(); return; }
  try {
    const raw = JSON.stringify(body);
    if (queue) await queue.enqueue('slack', request.utterance.eventId, raw);
    await ack();
    if (!queue) await processBody(raw);
  } catch (err) {
    console.error('slack_event_failed', err instanceof Error ? err.message : 'unknown');
  }
});
let shutdown: Promise<void> | undefined;
function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    console.log(`shutdown_started signal=${signal}`);
    await client.disconnect();
    await queueWorker?.stop();
    const drained = await inFlight.drain(30_000);
    if (!drained) {
      process.exitCode = 1;
      console.error('shutdown_slack_drain_timed_out');
    } else {
      console.log('shutdown_complete');
    }
  })();
  return shutdown;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void gracefulShutdown(signal).catch(error => {
      process.exitCode = 1;
      console.error('shutdown_failed', error instanceof Error ? error.message : 'unknown');
    });
  });
}

await client.start();
console.log('Nogita Slack Socket Mode is connected. Mention @Nogita in an invited channel or DM "Nogita, hello".');
