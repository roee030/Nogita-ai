import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NogitaEngine } from '../core/engine.ts';
import { DemoMeeting } from '../adapters/demo.ts';
import { RecallMeeting } from '../adapters/recall.ts';
import { AttendeeMeeting } from '../adapters/attendee.ts';
import { SlackThreadMeeting, verifySlackSignature } from '../adapters/slack.ts';
import { createDependencies, loadDotEnv } from './config.ts';
import { parseSlackRequest, type SlackEnvelope } from './slack-event.ts';
import { parseAttendeeEndedSession, parseAttendeeEnvelope, parseAttendeeTranscript, verifyAttendeeWebhookSignature } from './attendee-webhook.ts';
import { buildReadinessReport, validAdminToken } from './readiness.ts';
import { FileBindingRegistry, FileEventLedger } from './event-ledger.ts';
import { finishEventClaim } from './claimed-event.ts';
import { InFlightWork } from './in-flight.ts';
import { AttendeeEnrollmentCandidates } from './attendee-enrollment.ts';
import { AttendeeCommandRouter } from './attendee-command-router.ts';
import { SessionUsageRegistry } from './session-usage.ts';
import { EncryptedFileEventQueue } from './durable-event-queue.ts';
import { EventWorker } from './event-worker.ts';
import type { Utterance } from '../core/contracts.ts';
import { synthesizeLocalMp3 } from './local-tts.ts';
import { probeConnections } from './connection-probes.ts';

loadDotEnv();
const env = process.env;
const token = env.NOGITA_ADMIN_TOKEN;
if (!validAdminToken(token)) {
  throw new Error('Set a strong NOGITA_ADMIN_TOKEN in .env before starting server');
}
let providerConfigValid = true;
let dependencies: ReturnType<typeof createDependencies>;
try {
  dependencies = createDependencies(env);
} catch {
  providerConfigValid = false;
  console.error('provider_configuration_invalid');
  const safeEnv = { ...env, BOARD_PROVIDER: 'demo', REPO_PROVIDER: 'demo', NOGITA_MODE: 'demo' };
  try {
    dependencies = createDependencies(safeEnv);
  } catch {
    dependencies = createDependencies({ ...safeEnv, IDENTITY_MAP_JSON: '[]' });
  }
}
const attendeeHourlyPrice = Number(env.ATTENDEE_USD_PER_HOUR ?? '0.50');
const sessionUsage = new SessionUsageRegistry(attendeeHourlyPrice);
const nogita = new NogitaEngine({ ...dependencies, usage: sessionUsage });
const allowedSlackTeams = new Set((env.SLACK_ALLOWED_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const meetingHandles = new Map<string, DemoMeeting>();
const stateDirectory = env.NOGITA_STATE_DIR ?? '.nogita-state';
let providerQueue: EncryptedFileEventQueue | undefined;
try {
  if (env.NOGITA_QUEUE_ENCRYPTION_KEY) {
    providerQueue = new EncryptedFileEventQueue(stateDirectory, env.NOGITA_QUEUE_ENCRYPTION_KEY);
  }
} catch { console.error('durable_queue_configuration_invalid'); }
const slackLedger = new FileEventLedger(stateDirectory);
const attendeeLedger = new FileEventLedger(stateDirectory);
const attendeeBindings = new FileBindingRegistry(stateDirectory);
const attendeeBotsBySession = new Map<string, string>();
const attendeeMeetingsBySession = new Map<string, AttendeeMeeting>();
const slackThreads = new Set<string>();
const slackWork = new InFlightWork();
const attendeeEnrollment = new AttendeeEnrollmentCandidates();
const attendeeCommands = new AttendeeCommandRouter(
  async (sessionId, utterance) => { await nogita.onUtterance(sessionId, utterance); },
  async (sessionId, message) => {
    const meeting = attendeeMeetingsBySession.get(sessionId);
    if (!meeting) throw new Error('unknown Attendee meeting');
    await meeting.sendStatus(message);
  },
  { onError: error => console.error('attendee_command_failed', error instanceof Error ? error.message : 'unknown'),
    onLeave: async sessionId => {
      const meeting = attendeeMeetingsBySession.get(sessionId);
      const botId = meeting?.botIdentifier;
      if (meeting) {
        try { await meeting.sendStatus('Okay, I am leaving the call now.'); }
        catch { console.error('leave_acknowledgement_failed'); }
      }
      await nogita.endSession(sessionId);
      sessionUsage.end(sessionId);
      await forgetAttendeeSession(sessionId, botId);
    } },
);

async function forgetAttendeeSession(sessionId: string, botId?: string): Promise<void> {
  attendeeCommands.endSession(sessionId);
  attendeeMeetingsBySession.delete(sessionId);
  attendeeBotsBySession.delete(sessionId);
  if (botId) await attendeeBindings.remove(sessionId, botId);
}

function restoreAttendeeSession(sessionId: string, botId: string): void {
  if (nogita.hasSession(sessionId)) return;
  const meeting = new AttendeeMeeting(sessionId, env.ATTENDEE_API_KEY ?? '',
    env.ATTENDEE_PRIVACY_REVIEWED === 'true', fetch, env.ATTENDEE_WEBHOOK_URL, undefined, synthesizeLocalMp3);
  meeting.attach(botId);
  nogita.restoreSession(sessionId, meeting);
  sessionUsage.start(sessionId, 'attendee');
  attendeeMeetingsBySession.set(sessionId, meeting);
  attendeeCommands.beginSession(sessionId);
}

function safeToken(auth: string | undefined): boolean {
  const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(token!); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a,b);
}
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Buffer);
    total += b.length;
    if (total > 128 * 1024) throw new Error('body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function respond(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function processSlack(raw: string): Promise<void> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (payload.type !== 'event_callback') return;
  const request = parseSlackRequest(payload as SlackEnvelope, allowedSlackTeams,
    env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || !env.SLACK_BOT_TOKEN) return;
  if (!slackWork.accepting) throw new Error('service is shutting down');
  const ledger = await slackLedger.begin('slack', request.utterance.eventId);
  if (ledger.status !== 'started') return;
  const work = finishEventClaim(ledger.claim, async () => {
    if (!slackThreads.has(request.sessionId)) {
      await nogita.startSession(request.sessionId,
        new SlackThreadMeeting(request.sessionId, env.SLACK_BOT_TOKEN!, request.channel, request.threadTs));
      slackThreads.add(request.sessionId);
    }
    await nogita.onUtterance(request.sessionId, request.utterance);
  });
  slackWork.track(work);
  await work;
}

async function authorizeAttendeeEnvelope(envelope: NonNullable<ReturnType<typeof parseAttendeeEnvelope>>): Promise<boolean> {
  const activeBot = attendeeBotsBySession.get(envelope.sessionId);
  if (activeBot && activeBot !== envelope.botId) return false;
  if (!activeBot) {
    if (!await attendeeBindings.has(envelope.sessionId, envelope.botId)) return false;
    attendeeBotsBySession.set(envelope.sessionId, envelope.botId);
  }
  return true;
}

async function processAttendee(payload: Record<string, unknown>): Promise<void> {
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !await authorizeAttendeeEnvelope(envelope)) return;
  const ledger = await attendeeLedger.begin('attendee', envelope.eventId);
  if (ledger.status === 'completed') return;
  if (ledger.status === 'active') throw new Error('Attendee event is still processing');
  if (ledger.status !== 'started') throw new Error('unexpected Attendee ledger state');
  const claim = ledger.claim;
  try {
    const endedSession = parseAttendeeEndedSession(payload);
    if (endedSession) {
      await nogita.endSession(endedSession, false);
      sessionUsage.end(endedSession);
      await forgetAttendeeSession(endedSession, envelope.botId);
    } else {
      const transcript = parseAttendeeTranscript(payload, dependencies.identities);
      if (transcript) {
        if (!transcript.utterance.actor.verified && transcript.attendeeUserUuid) {
          attendeeEnrollment.observe(transcript.attendeeUserUuid);
        }
        restoreAttendeeSession(transcript.sessionId, envelope.botId);
        await attendeeCommands.accept(transcript);
      }
    }
    await claim.complete();
  } catch (error) {
    try { await claim.abandon(); } catch { console.error('attendee_ledger_release_failed'); }
    throw error;
  }
}

const providerWorker = providerQueue ? new EventWorker(providerQueue, async item => {
  if (item.namespace === 'slack') await processSlack(item.payload);
  else await processAttendee(JSON.parse(item.payload) as Record<string, unknown>);
}, { concurrency: 4, onError: error => console.error('provider_event_failed',
  error instanceof Error ? error.message : 'unknown') }) : undefined;
providerWorker?.start();

async function acceptSlack(raw: string): Promise<{ status: number; response: unknown }> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return { status: 200, response: { challenge: payload.challenge } };
  }
  if (payload.type !== 'event_callback') return { status: 200, response: { ok: true } };
  const request = parseSlackRequest(payload as SlackEnvelope, allowedSlackTeams,
    env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || !env.SLACK_BOT_TOKEN) return { status: 200, response: { ok: true } };
  if (providerQueue) await providerQueue.enqueue('slack', request.utterance.eventId, raw);
  else await processSlack(raw);
  return { status: 200, response: { ok: true } };
}

async function acceptAttendee(raw: string, signature: string | undefined): Promise<{ status: number; response: unknown }> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (!verifyAttendeeWebhookSignature(env.ATTENDEE_WEBHOOK_SECRET ?? '', payload, signature)) {
    return { status: 401, response: { error: 'invalid Attendee signature' } };
  }
  if (!providerConfigValid) return { status: 503, response: { error: 'provider configuration invalid' } };
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope || !await authorizeAttendeeEnvelope(envelope)) return { status: 200, response: { ok: true } };
  if (providerQueue) await providerQueue.enqueue('attendee', envelope.eventId, raw);
  else await processAttendee(payload);
  return { status: 200, response: { ok: true } };
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/health') {
      respond(res, 200, { ok: true, service: 'nogita', sessions: nogita.sessionCount() }); return;
    }
    if (req.method === 'POST' && pathname === '/slack/events') {
      const raw = await readRaw(req);
      if (!verifySlackSignature(env.SLACK_SIGNING_SECRET ?? '',
        req.headers['x-slack-request-timestamp'] as string | undefined ?? null,
        req.headers['x-slack-signature'] as string | undefined ?? null, raw)) {
        respond(res, 401, { error: 'invalid Slack signature' }); return;
      }
      if (!providerConfigValid) { respond(res, 503, { error: 'provider configuration invalid' }); return; }
      const result = await acceptSlack(raw);
      respond(res, result.status, result.response); return;
    }
    if (req.method === 'POST' && pathname === '/webhooks/attendee') {
      const result = await acceptAttendee(await readRaw(req),
        req.headers['x-webhook-signature'] as string | undefined);
      respond(res, result.status, result.response); return;
    }
    if (!safeToken(req.headers.authorization)) { respond(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && pathname === '/api/connections') {
      const report = await probeConnections(env);
      respond(res, report.ok ? 200 : 503, report); return;
    }
    if (req.method === 'GET' && pathname === '/api/readiness') {
      const report = buildReadinessReport(env, dependencies.identities, process.versions.node, providerConfigValid);
      respond(res, report.ok ? 200 : 503, report); return;
    }
    const usageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/usage$/);
    if (req.method === 'GET' && usageMatch) {
      const sessionId = decodeURIComponent(usageMatch[1]!);
      const ai = dependencies.brain.usageFor?.(sessionId);
      const report = sessionUsage.report(sessionId, ai);
      respond(res, report ? 200 : 404, report ?? { error: 'unknown session usage' }); return;
    }
    if (req.method === 'GET' && pathname === '/api/attendee/enrollment-candidates') {
      respond(res, 200, { candidates: attendeeEnrollment.list(), retentionSeconds: 3600 }); return;
    }
    if (!providerConfigValid) { respond(res, 503, { error: 'provider configuration invalid' }); return; }
    if (req.method === 'POST' && pathname === '/api/sessions') {
      const payload = JSON.parse(await readRaw(req)) as {
        id?: string; meetingUrl?: string; provider?: string; ownerActorId?: string;
      };
      if (typeof payload.id !== 'string' || !payload.id) { respond(res, 400, { error: 'session id required' }); return; }
      const provider = payload.provider ?? env.MEETING_PROVIDER ?? 'demo';
      if (provider !== 'recall' && provider !== 'attendee' && provider !== 'demo') {
        respond(res, 400, { error: 'unsupported meeting provider' }); return;
      }
      const ownerRecord = payload.ownerActorId ? dependencies.identities.fromId(payload.ownerActorId) : undefined;
      const owner = ownerRecord
        ? { id: ownerRecord.id, displayName: ownerRecord.displayName, verified: true }
        : undefined;
      if (payload.ownerActorId && (!owner || !dependencies.policy.mayWriteTask(owner))) {
        respond(res, 403, { error: 'authorized meeting owner required' }); return;
      }
      const attendeeChallenge = provider === 'attendee'
        ? attendeeCommands.beginSession(payload.id, owner)
        : undefined;
      const meeting = provider === 'recall'
        ? new RecallMeeting(payload.id, env.RECALL_API_KEY ?? '', env.RECALL_REGION ?? 'us-east-1')
        : provider === 'attendee'
        ? new AttendeeMeeting(payload.id, env.ATTENDEE_API_KEY ?? '', env.ATTENDEE_PRIVACY_REVIEWED === 'true',
            fetch, env.ATTENDEE_WEBHOOK_URL, attendeeChallenge
              ? `To verify your identity for this meeting, please say: ${attendeeChallenge}`
              : undefined, synthesizeLocalMp3)
        : new DemoMeeting(payload.id);
      try {
        await nogita.startSession(payload.id, meeting, payload.meetingUrl);
      } catch (error) {
        if (provider === 'attendee') attendeeCommands.endSession(payload.id);
        throw error;
      }
      sessionUsage.start(payload.id, provider);
      if (meeting instanceof DemoMeeting) meetingHandles.set(payload.id, meeting);
      if (meeting instanceof AttendeeMeeting) {
        const botId = meeting.botIdentifier;
        if (!botId) throw new Error('Attendee did not return a bot ID');
        try {
          await attendeeBindings.register(payload.id, botId);
          attendeeBotsBySession.set(payload.id, botId);
          attendeeMeetingsBySession.set(payload.id, meeting);
        } catch (error) {
          await nogita.endSession(payload.id);
          sessionUsage.end(payload.id);
          await forgetAttendeeSession(payload.id, botId);
          throw error;
        }
      }
      respond(res, 201, { sessionId: payload.id, provider, capabilities: [...meeting.capabilities],
        enrollmentRequired: provider === 'attendee' && Boolean(owner) }); return;
    }
    if (req.method === 'POST' && pathname === '/api/utterances') {
      // DEVELOPMENT INGESTION ONLY: not a live meeting audio bridge.
      const payload = JSON.parse(await readRaw(req)) as { sessionId?: string; utterance?: Utterance };
      if (!payload.sessionId || !payload.utterance || typeof payload.utterance.text !== 'string' ||
          typeof payload.utterance.eventId !== 'string' || typeof payload.utterance.actor?.id !== 'string') {
        respond(res, 400, { error: 'invalid utterance' }); return;
      }
      const result = await nogita.onUtterance(payload.sessionId, payload.utterance);
      const debug = meetingHandles.get(payload.sessionId);
      respond(res, 200, { result, outputs: debug?.events.splice(0) ?? [] }); return;
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(pathname.slice('/api/sessions/'.length));
      const attendeeBotId = attendeeBotsBySession.get(id);
      await nogita.endSession(id);
      meetingHandles.delete(id);
      sessionUsage.end(id);
      await forgetAttendeeSession(id, attendeeBotId);
      respond(res, 200, { ended: id }); return;
    }
    respond(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('request_failed', error instanceof Error ? error.message : 'unknown');
    respond(res, 400, { error: error instanceof Error ? error.message : 'request failed' });
  }
});
const host = env.HOST ?? '127.0.0.1';
const port = Number(env.PORT ?? '8787');
server.listen(port, host, () => console.log(`Nogita dev server listening on http://${host}:${port}`));

let shutdown: Promise<void> | undefined;
function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    console.log(`shutdown_started signal=${signal}`);
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
    const [drained] = await Promise.all([slackWork.drain(30_000), closed, providerWorker?.stop()]);
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
