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
import type { Utterance } from '../core/contracts.ts';

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
const nogita = new NogitaEngine(dependencies);
const allowedSlackTeams = new Set((env.SLACK_ALLOWED_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const meetingHandles = new Map<string, DemoMeeting>();
const stateDirectory = env.NOGITA_STATE_DIR ?? '.nogita-state';
const slackLedger = new FileEventLedger(stateDirectory);
const attendeeLedger = new FileEventLedger(stateDirectory);
const attendeeBindings = new FileBindingRegistry(stateDirectory);
const attendeeBotsBySession = new Map<string, string>();
const slackThreads = new Set<string>();

async function forgetAttendeeSession(sessionId: string, botId?: string): Promise<void> {
  attendeeBotsBySession.delete(sessionId);
  if (botId) await attendeeBindings.remove(sessionId, botId);
}

function restoreAttendeeSession(sessionId: string, botId: string): void {
  if (nogita.hasSession(sessionId)) return;
  const meeting = new AttendeeMeeting(sessionId, env.ATTENDEE_API_KEY ?? '',
    env.ATTENDEE_PRIVACY_REVIEWED === 'true', fetch, env.ATTENDEE_WEBHOOK_URL);
  meeting.attach(botId);
  nogita.restoreSession(sessionId, meeting);
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

async function handleSlack(raw: string): Promise<{ status: number; response: unknown }> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return { status: 200, response: { challenge: payload.challenge } };
  }
  if (payload.type !== 'event_callback') return { status: 200, response: { ok: true } };
  const request = parseSlackRequest(payload as SlackEnvelope, allowedSlackTeams,
    env.SLACK_BOT_USER_ID, dependencies.identities);
  if (!request || !env.SLACK_BOT_TOKEN) {
    return { status: 200, response: { ok: true } };
  }
  const ledger = await slackLedger.begin('slack', request.utterance.eventId);
  if (ledger.status !== 'started') return { status: 200, response: { ok: true } };
  void finishEventClaim(ledger.claim, async () => {
    if (!slackThreads.has(request.sessionId)) {
      await nogita.startSession(request.sessionId,
        new SlackThreadMeeting(request.sessionId, env.SLACK_BOT_TOKEN!, request.channel, request.threadTs));
      slackThreads.add(request.sessionId);
    }
    await nogita.onUtterance(request.sessionId, request.utterance);
  }).catch(err => {
    console.error('slack_event_failed', err instanceof Error ? err.message : 'unknown');
  });
  return { status: 200, response: { ok: true } };
}

async function handleAttendee(raw: string, signature: string | undefined): Promise<{ status: number; response: unknown }> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (!verifyAttendeeWebhookSignature(env.ATTENDEE_WEBHOOK_SECRET ?? '', payload, signature)) {
    return { status: 401, response: { error: 'invalid Attendee signature' } };
  }
  if (!providerConfigValid) return { status: 503, response: { error: 'provider configuration invalid' } };
  const envelope = parseAttendeeEnvelope(payload);
  if (!envelope) {
    return { status: 200, response: { ok: true } };
  }
  const activeBot = attendeeBotsBySession.get(envelope.sessionId);
  if (activeBot && activeBot !== envelope.botId) return { status: 200, response: { ok: true } };
  if (!activeBot) {
    if (!await attendeeBindings.has(envelope.sessionId, envelope.botId)) {
      return { status: 200, response: { ok: true } };
    }
    attendeeBotsBySession.set(envelope.sessionId, envelope.botId);
  }
  const ledger = await attendeeLedger.begin('attendee', envelope.eventId);
  if (ledger.status === 'completed') return { status: 200, response: { ok: true } };
  if (ledger.status === 'active') {
    return { status: 503, response: { error: 'Attendee event is still processing' } };
  }
  if (ledger.status !== 'started') throw new Error('unexpected Attendee ledger state');
  const claim = ledger.claim;

  try {
    const endedSession = parseAttendeeEndedSession(payload);
    if (endedSession) {
      await nogita.endSession(endedSession, false);
      await forgetAttendeeSession(endedSession, envelope.botId);
    } else {
      const transcript = parseAttendeeTranscript(payload, dependencies.identities);
      if (transcript) {
        restoreAttendeeSession(transcript.sessionId, envelope.botId);
        await nogita.onUtterance(transcript.sessionId, transcript.utterance);
      }
    }
    await claim.complete();
    return { status: 200, response: { ok: true } };
  } catch (error) {
    try { await claim.abandon(); } catch { console.error('attendee_ledger_release_failed'); }
    console.error('attendee_event_failed', error instanceof Error ? error.message : 'unknown');
    return { status: 503, response: { error: 'Attendee event processing failed' } };
  }
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
      const result = await handleSlack(raw);
      respond(res, result.status, result.response); return;
    }
    if (req.method === 'POST' && pathname === '/webhooks/attendee') {
      const result = await handleAttendee(await readRaw(req),
        req.headers['x-webhook-signature'] as string | undefined);
      respond(res, result.status, result.response); return;
    }
    if (!safeToken(req.headers.authorization)) { respond(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && pathname === '/api/readiness') {
      const report = buildReadinessReport(env, dependencies.identities, process.versions.node, providerConfigValid);
      respond(res, report.ok ? 200 : 503, report); return;
    }
    if (!providerConfigValid) { respond(res, 503, { error: 'provider configuration invalid' }); return; }
    if (req.method === 'POST' && pathname === '/api/sessions') {
      const payload = JSON.parse(await readRaw(req)) as { id?: string; meetingUrl?: string; provider?: string };
      if (typeof payload.id !== 'string' || !payload.id) { respond(res, 400, { error: 'session id required' }); return; }
      const provider = payload.provider ?? env.MEETING_PROVIDER ?? 'demo';
      if (provider !== 'recall' && provider !== 'attendee' && provider !== 'demo') {
        respond(res, 400, { error: 'unsupported meeting provider' }); return;
      }
      const meeting = provider === 'recall'
        ? new RecallMeeting(payload.id, env.RECALL_API_KEY ?? '', env.RECALL_REGION ?? 'us-east-1')
        : provider === 'attendee'
        ? new AttendeeMeeting(payload.id, env.ATTENDEE_API_KEY ?? '', env.ATTENDEE_PRIVACY_REVIEWED === 'true',
            fetch, env.ATTENDEE_WEBHOOK_URL)
        : new DemoMeeting(payload.id);
      await nogita.startSession(payload.id, meeting, payload.meetingUrl);
      if (meeting instanceof DemoMeeting) meetingHandles.set(payload.id, meeting);
      if (meeting instanceof AttendeeMeeting) {
        const botId = meeting.botIdentifier;
        if (!botId) throw new Error('Attendee did not return a bot ID');
        try {
          await attendeeBindings.register(payload.id, botId);
          attendeeBotsBySession.set(payload.id, botId);
        } catch (error) {
          await nogita.endSession(payload.id);
          throw error;
        }
      }
      respond(res, 201, { sessionId: payload.id, provider, capabilities: [...meeting.capabilities] }); return;
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
      try {
        await nogita.endSession(id);
      } finally {
        meetingHandles.delete(id);
        await forgetAttendeeSession(id, attendeeBotId);
      }
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
