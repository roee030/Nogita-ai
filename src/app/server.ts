import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { NogitaEngine, type Speculation } from '../core/engine.ts';
import { DemoMeeting } from '../adapters/demo.ts';
import { RecallMeeting } from '../adapters/recall.ts';
import { AttendeeMeeting } from '../adapters/attendee.ts';
import { SlackThreadMeeting, verifySlackSignature } from '../adapters/slack.ts';
import { createDependencies, loadDotEnv } from './config.ts';
import { parseSlackRequest, type SlackEnvelope } from './slack-event.ts';
import { registerSlackEventHandlers } from './slack-socket-events.ts';
import { parseAttendeeBotLog, parseAttendeeEnvelope, parseAttendeeLifecycleEvent, parseAttendeeParticipantEvent, parseAttendeeTranscript, verifyAttendeeWebhookSignature } from './attendee-webhook.ts';
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
import { SlackConversationRegistry } from './slack-conversations.ts';
import { AttendeeRealtimeAudioHub, DEFAULT_EAGER_EOT_THRESHOLD } from './attendee-realtime-audio.ts';
import { notifyBeforeCleanup } from './attendee-lifecycle.ts';
import { PresenceHub } from './presence.ts';
import { directlyAddressesNogita } from '../core/policy.ts';
import { readFileSync } from 'node:fs';

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
if (dependencies.code.prepare) {
  void dependencies.code.prepare().catch(() => console.error('repository_index_warmup_failed'));
}
const attendeeHourlyPrice = Number(env.ATTENDEE_USD_PER_HOUR ?? '0.50');
const sessionUsage = new SessionUsageRegistry(attendeeHourlyPrice, Date.now,
  Number(env.DEEPGRAM_NOVA3_MULTILINGUAL_USD_PER_MINUTE ?? '0.0058'),
  Number(env.DEEPGRAM_AURA2_USD_PER_THOUSAND_CHARACTERS ?? '0.03'));
const presence = new PresenceHub({ boardName: dependencies.board.name, chatName: dependencies.chat?.name });
// The presence page is shared in Attendee meetings unless NOGITA_PRESENCE=off; "camera" shows it as her webcam.
const presenceMode = env.NOGITA_PRESENCE === 'off' ? undefined : env.NOGITA_PRESENCE === 'camera' ? 'camera' as const : 'screenshare' as const;
const publicBaseUrl = (() => {
  try { return new URL(env.NOGITA_PUBLIC_URL || env.ATTENDEE_WEBHOOK_URL || '').origin; } catch { return undefined; }
})();
const presencePage = readFileSync(new URL('./presence-page.html', import.meta.url), 'utf8');
const nogita = new NogitaEngine({ ...dependencies, usage: sessionUsage },
  { handRaiseFallback: env.NOGITA_HAND_RAISE_FALLBACK === 'chat' ? 'chat' : 'none',
    onQuestion: (sessionId, event) => presence.question(sessionId, event),
    onActivity: (sessionId, activity) => {
      if (activity.kind === 'tool') presence.tool(sessionId, activity.questionId, activity.tools);
      else presence.waiting(sessionId, activity.waiting);
    } });
const allowedSlackTeams = new Set((env.SLACK_ALLOWED_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const meetingHandles = new Map<string, DemoMeeting>();
const stateDirectory = env.NOGITA_STATE_DIR ?? '.nogita-state';
const MAX_SLACK_CONVERSATIONS = 500;
const slackConversations = new SlackConversationRegistry(MAX_SLACK_CONVERSATIONS);
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
const realtimeAudioEnabled = env.NOGITA_REALTIME_AUDIO_ENABLED === 'true';
if (env.NOGITA_REALTIME_AUDIO_ENABLED !== undefined && !['true', 'false'].includes(env.NOGITA_REALTIME_AUDIO_ENABLED)) {
  providerConfigValid = false;
  console.error('realtime_audio_configuration_invalid');
}
if (realtimeAudioEnabled && (!env.ATTENDEE_AUDIO_WEBSOCKET_URL || !env.DEEPGRAM_API_KEY ||
    env.ATTENDEE_PRIVACY_REVIEWED !== 'true' || !env.ATTENDEE_WEBHOOK_SECRET || env.MEETING_PROVIDER !== 'attendee')) {
  providerConfigValid = false;
  console.error('realtime_audio_configuration_incomplete');
}
const slackThreads = new Set<string>();
const slackThreadReader = dependencies.chat?.readThread
  ? (channel: string, threadTs: string) => dependencies.chat!.readThread!(channel, threadTs) : undefined;
const slackWork = new InFlightWork();
const slackSocketClient = env.SLACK_APP_TOKEN?.startsWith('xapp-') && env.SLACK_BOT_TOKEN?.startsWith('xoxb-')
  ? new SocketModeClient({ appToken: env.SLACK_APP_TOKEN }) : undefined;
let slackSocketConnected = false;
const attendeeEnrollment = new AttendeeEnrollmentCandidates();
const attendeeCommands = new AttendeeCommandRouter(
  async (sessionId, utterance, context) => {
    await nogita.onUtterance(sessionId, utterance, { speakerKey: context.speakerKey,
      ...(context.speculation ? { speculation: context.speculation as Speculation } : {}) });
  },
  async (sessionId, message) => {
    const meeting = attendeeMeetingsBySession.get(sessionId);
    if (!meeting) throw new Error('unknown Attendee meeting');
    await meeting.sendStatus(message, 1_500);
  },
  { onError: error => console.error('attendee_command_failed', error instanceof Error ? error.message : 'unknown'),
    onChatAck: (sessionId, durationMs) => sessionUsage.recordResponseStage(sessionId, 'transcript_to_chat_ack', durationMs),
    onSpeechActivity: (sessionId, speakerUuid) => nogita.cancelProgressForSpeechActivity(sessionId, speakerUuid),
    chatAck: !realtimeAudioEnabled,
    ...(env.DEEPGRAM_STT_MODE === 'flux-english' && env.DEEPGRAM_EAGER_EOT_THRESHOLD !== 'off'
      ? { speculate: (sessionId: string, utterance: Utterance) => nogita.speculate(sessionId, utterance) } : {}),
    onLeave: async sessionId => {
      const meeting = attendeeMeetingsBySession.get(sessionId);
      const botId = meeting?.botIdentifier;
      if (meeting) {
        try { await meeting.sendStatus('I’m leaving the call now, as requested.'); }
        catch { console.error('leave_acknowledgement_failed'); }
      }
      try { await nogita.endSession(sessionId); }
      catch {
        if (meeting) {
          try { await meeting.sendStatus('I could not leave the call yet; I may still be connected. Please ask me to leave again or remove me from the meeting.'); }
          catch { console.error('leave_failure_notice_failed'); }
        }
        return;
      }
      sessionUsage.end(sessionId);
      await forgetAttendeeSession(sessionId, botId);
    } },
);

let realtimeAudio: AttendeeRealtimeAudioHub | undefined;
if (realtimeAudioEnabled && env.ATTENDEE_AUDIO_WEBSOCKET_URL && env.DEEPGRAM_API_KEY && env.ATTENDEE_WEBHOOK_SECRET) {
  try { realtimeAudio = new AttendeeRealtimeAudioHub({
      baseUrl: env.ATTENDEE_AUDIO_WEBSOCKET_URL,
      signingSecret: env.ATTENDEE_WEBHOOK_SECRET,
      deepgramApiKey: env.DEEPGRAM_API_KEY,
      sttMode: env.DEEPGRAM_STT_MODE === 'flux-english' ? 'flux-english' : 'nova3-multilingual',
      ttsModel: env.DEEPGRAM_TTS_MODEL, warmSpeech: true,
      ...(env.DEEPGRAM_EOT_THRESHOLD ? { fluxEndOfTurnThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD) } : {}),
      ...(env.DEEPGRAM_EAGER_EOT_THRESHOLD !== 'off'
        ? { fluxEagerEndOfTurnThreshold: Number(env.DEEPGRAM_EAGER_EOT_THRESHOLD || DEFAULT_EAGER_EOT_THRESHOLD) } : {}),
      onTranscript: async (sessionId, participantUuid, text, participant) => {
        const request = transcriptRequest(sessionId, participantUuid, text, participant);
        if (env.DEEPGRAM_STT_MODE === 'flux-english') await attendeeCommands.acceptCompletedTurn(request);
        else await attendeeCommands.acceptFinal(request);
      },
      onSpeechActivity: (sessionId, participantUuid) => attendeeCommands.noteSpeechActivity(sessionId, participantUuid),
      onEagerTranscript: (sessionId, participantUuid, text, participant) =>
        attendeeCommands.acceptEagerTurn(transcriptRequest(sessionId, participantUuid, text, participant)),
      onTurnResumed: (sessionId, participantUuid) => attendeeCommands.resumeTurn(sessionId, participantUuid),
      onVoice: (sessionId, participantUuid) => {
        nogita.noteVoice(sessionId, participantUuid);
        presence.voice(sessionId, participantUuid);
      },
      onInterim: (sessionId, participantUuid, text) => {
        if (directlyAddressesNogita(text)) presence.addressed(sessionId, participantUuid);
      },
      onInputLevel: (sessionId, rms) => presence.inputLevel(sessionId, rms),
      onOutputAudio: (sessionId, pcm) => presence.outputAudio(sessionId, pcm),
      onError: code => console.error(code),
      onUsage: (sessionId, usage) => {
        if (usage.sttBytes) sessionUsage.recordDeepgramSttBytes(sessionId, usage.sttBytes);
        if (usage.ttsCharacters) sessionUsage.recordDeepgramTtsCharacters(sessionId, usage.ttsCharacters);
      },
      authorizeRecoveredBot: async (sessionId, botId) => {
        if (!await attendeeBindings.has(sessionId, botId)) return false;
        attendeeBotsBySession.set(sessionId, botId);
        if (nogita.hasSession(sessionId)) realtimeAudio?.bindBot(sessionId, botId);
        else restoreAttendeeSession(sessionId, botId);
        return true;
      },
    }); }
  catch { providerConfigValid = false; console.error('realtime_audio_configuration_invalid'); }
}

function transcriptRequest(sessionId: string, participantUuid: string, text: string,
  participant?: { attendeeUserUuid?: string; displayName?: string }) {
  const mapped = participant?.attendeeUserUuid
    ? dependencies.identities.fromAttendee(participant.attendeeUserUuid) : undefined;
  return { sessionId, botId: attendeeBotsBySession.get(sessionId) ?? '',
    speakerUuid: participantUuid, ...(participant?.attendeeUserUuid ? { attendeeUserUuid: participant.attendeeUserUuid } : {}),
    utterance: { eventId: `realtime-${randomUUID()}`,
      actor: mapped ? { id: mapped.id, displayName: mapped.displayName, verified: true }
        : { id: `unmapped:attendee:${participant?.attendeeUserUuid ?? participantUuid}`,
          displayName: participant?.displayName ?? 'Meeting participant', verified: false },
      text, at: Date.now() } };
}

async function forgetAttendeeSession(sessionId: string, botId?: string): Promise<void> {
  presence.close(sessionId);
  attendeeCommands.endSession(sessionId);
  attendeeMeetingsBySession.delete(sessionId);
  attendeeBotsBySession.delete(sessionId);
  realtimeAudio?.closeSession(sessionId);
  if (botId) await attendeeBindings.remove(sessionId, botId);
}

function restoreAttendeeSession(sessionId: string, botId: string): void {
  if (nogita.hasSession(sessionId)) return;
  const meeting = new AttendeeMeeting(sessionId, env.ATTENDEE_API_KEY ?? '',
    env.ATTENDEE_PRIVACY_REVIEWED === 'true', fetch, env.ATTENDEE_WEBHOOK_URL, undefined, synthesizeLocalMp3,
    (stage, durationMs) => sessionUsage.recordSpeechStage(sessionId, stage, durationMs), undefined,
    realtimeAudio ? text => realtimeAudio.speak(sessionId, text) : undefined);
  meeting.attach(botId);
  nogita.restoreSession(sessionId, meeting);
  if (realtimeAudio && !realtimeAudio.hasSession(sessionId)) realtimeAudio.register(sessionId);
  if (realtimeAudio) realtimeAudio.bindBot(sessionId, botId);
  sessionUsage.start(sessionId, 'attendee', Boolean(realtimeAudio));
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
    env.SLACK_BOT_USER_ID, dependencies.identities, id => nogita.hasSession(id));
  if (!request || !env.SLACK_BOT_TOKEN) return;
  const lease = slackConversations.enter(request.sessionId);
  try {
    if (!slackWork.accepting) throw new Error('service is shutting down');
    const ledger = await slackLedger.begin('slack', request.utterance.eventId);
    if (ledger.status !== 'started') return;
    const work = finishEventClaim(ledger.claim, async () => {
      if (!nogita.hasSession(request.sessionId)) {
        await reapSlackConversations();
        if (slackConversations.size > MAX_SLACK_CONVERSATIONS) {
          await new SlackThreadMeeting(request.sessionId, env.SLACK_BOT_TOKEN!, request.channel, request.threadTs)
            .sendStatus('I am at conversation capacity right now. Please try again in a few minutes.');
          return;
        }
        await nogita.startSession(request.sessionId,
          new SlackThreadMeeting(request.sessionId, env.SLACK_BOT_TOKEN!, request.channel, request.threadTs, fetch, slackThreadReader));
      }
      await nogita.onUtterance(request.sessionId, request.utterance);
    });
    slackWork.track(work);
    await work;
  } finally {
    lease.release();
    if (!nogita.hasSession(request.sessionId)) slackConversations.forget(request.sessionId);
  }
}

async function reapSlackConversations(): Promise<void> {
  for (const sessionId of slackConversations.cleanupCandidates()) {
    if (slackConversations.isActive(sessionId)) continue;
    try {
      await nogita.endSession(sessionId);
      sessionUsage.end(sessionId);
      slackConversations.forget(sessionId);
    } catch (error) {
      console.error('slack_session_cleanup_failed', error instanceof Error ? error.name : 'unknown');
    }
  }
}

const slackConversationReaper = setInterval(() => {
  void reapSlackConversations().catch(error => console.error('slack_session_cleanup_failed',
    error instanceof Error ? error.name : 'unknown'));
}, 60_000);
slackConversationReaper.unref();

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
    const lifecycle = parseAttendeeLifecycleEvent(payload);
    const botLog = lifecycle ? null : parseAttendeeBotLog(payload);
    if (lifecycle) {
      restoreAttendeeSession(lifecycle.sessionId, lifecycle.botId);
      const meeting = attendeeMeetingsBySession.get(lifecycle.sessionId);
      if (lifecycle.kind === 'fatal') presence.problem(lifecycle.sessionId, 'error', 'Connection lost');
      const message = lifecycle.kind === 'fatal'
        ? 'Nogita hit a fatal meeting-connection error and has left the call. Please add her again to restart.'
        : lifecycle.eventType === 'post_processing_completed'
          ? 'Nogita has left because the meeting has ended.'
          : 'Nogita has left the call because the meeting provider ended her session.';
      await notifyBeforeCleanup(
        async () => { if (meeting) await meeting.sendStatus(message); },
        async () => {
          await nogita.endSession(lifecycle.sessionId, false);
          sessionUsage.end(lifecycle.sessionId);
          await forgetAttendeeSession(lifecycle.sessionId, lifecycle.botId);
        },
        () => console.error('attendee_exit_notice_failed'),
      );
    } else if (botLog) {
      restoreAttendeeSession(botLog.sessionId, botLog.botId);
      const meeting = attendeeMeetingsBySession.get(botLog.sessionId);
      presence.problem(botLog.sessionId, 'warning', 'Connection issue · recovering');
      try {
        await meeting?.sendStatus('I hit a meeting-service error. I’m trying to recover, so my reply may be delayed.');
      } catch { console.error('attendee_error_notice_failed'); }
    } else {
      const participant = parseAttendeeParticipantEvent(payload);
      if (participant) {
        restoreAttendeeSession(participant.sessionId, envelope.botId);
        if (participant.eventType === 'join') realtimeAudio?.bindParticipant(participant.sessionId,
          participant.participantUuid, { attendeeUserUuid: participant.attendeeUserUuid, displayName: participant.displayName });
        else realtimeAudio?.participantLeft(participant.sessionId, participant.participantUuid);
      }
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
    env.SLACK_BOT_USER_ID, dependencies.identities, id => nogita.hasSession(id));
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

if (slackSocketClient) {
  type SocketPayload = { body: unknown; ack: () => Promise<void> };
  registerSlackEventHandlers<SocketPayload>(slackSocketClient, async ({ body, ack }) => {
    const request = parseSlackRequest(body as SlackEnvelope, allowedSlackTeams,
      env.SLACK_BOT_USER_ID, dependencies.identities, id => nogita.hasSession(id));
    if (!request || !providerConfigValid || !slackWork.accepting) { await ack(); return; }
    try {
      const raw = JSON.stringify(body);
      if (providerQueue) await providerQueue.enqueue('slack', request.utterance.eventId, raw);
      await ack();
      if (!providerQueue) {
        void processSlack(raw).catch(error => console.error('slack_event_failed',
          error instanceof Error ? error.name : 'unknown'));
      }
    } catch (error) {
      console.error('slack_event_failed', error instanceof Error ? error.name : 'unknown');
    }
  });
  slackSocketClient.on('connected', () => {
    slackSocketConnected = true;
    console.log('slack_socket_connected');
  });
  slackSocketClient.on('disconnected', error => {
    slackSocketConnected = false;
    if (error) console.error('slack_socket_disconnected', error instanceof Error ? error.name : 'unknown');
  });
  slackSocketClient.on('error', error => console.error('slack_socket_error',
    error instanceof Error ? error.name : 'unknown'));
  void slackSocketClient.start().catch(error => console.error('slack_socket_start_failed',
    error instanceof Error ? error.name : 'unknown'));
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/health') {
      respond(res, 200, { ok: true, service: 'nogita', sessions: nogita.sessionCount() }); return;
    }
    const presenceMatch = pathname.match(/^\/presence\/([^/]+)(\/events)?$/);
    if (req.method === 'GET' && presenceMatch) {
      const sessionId = decodeURIComponent(presenceMatch[1]!);
      if (!presenceMatch[2]) {
        // The page holds no data; it shows the state only with the meeting's key (or a labelled preview).
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        res.end(presencePage); return;
      }
      const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('k');
      if (!presence.authorized(sessionId, key)) { respond(res, 404, { error: 'unknown presence' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const unsubscribe = presence.subscribe(sessionId, (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (event === 'end') res.end();
      });
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.on('close', () => { clearInterval(keepAlive); unsubscribe?.(); });
      return;
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
      const report = buildReadinessReport(env, dependencies.identities, process.versions.node,
        providerConfigValid, slackSocketConnected);
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
      const realtimeAudioUrl = provider === 'attendee' && realtimeAudio ? realtimeAudio.register(payload.id) : undefined;
      const presencePageUrl = provider === 'attendee' && presenceMode && publicBaseUrl
        ? `${publicBaseUrl}/presence/${encodeURIComponent(payload.id)}?k=${presence.open(payload.id)}` : undefined;
      const meeting = provider === 'recall'
        ? new RecallMeeting(payload.id, env.RECALL_API_KEY ?? '', env.RECALL_REGION ?? 'us-east-1')
        : provider === 'attendee'
        ? new AttendeeMeeting(payload.id, env.ATTENDEE_API_KEY ?? '', env.ATTENDEE_PRIVACY_REVIEWED === 'true',
            fetch, env.ATTENDEE_WEBHOOK_URL, attendeeChallenge
              ? `To verify your identity for this meeting, please say: ${attendeeChallenge}`
              : undefined, synthesizeLocalMp3,
            (stage, durationMs) => sessionUsage.recordSpeechStage(payload.id!, stage, durationMs),
            realtimeAudioUrl, realtimeAudio ? text => realtimeAudio.speak(payload.id!, text) : undefined,
            presencePageUrl && presenceMode ? { url: presencePageUrl, mode: presenceMode } : undefined)
        : new DemoMeeting(payload.id);
      try {
        await nogita.startSession(payload.id, meeting, payload.meetingUrl);
      } catch (error) {
        if (provider === 'attendee') attendeeCommands.endSession(payload.id);
        realtimeAudio?.closeSession(payload.id);
        presence.close(payload.id);
        throw error;
      }
      sessionUsage.start(payload.id, provider, provider === 'attendee' && Boolean(realtimeAudio));
      if (meeting instanceof DemoMeeting) meetingHandles.set(payload.id, meeting);
      if (meeting instanceof AttendeeMeeting) {
        const botId = meeting.botIdentifier;
        if (!botId) throw new Error('Attendee did not return a bot ID');
        try {
          await attendeeBindings.register(payload.id, botId);
          attendeeBotsBySession.set(payload.id, botId);
          attendeeMeetingsBySession.set(payload.id, meeting);
          if (realtimeAudio) realtimeAudio.bindBot(payload.id, botId);
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
server.on('upgrade', (request, socket, head) => {
  if (!realtimeAudio || !realtimeAudio.handleUpgrade(request, socket, head)) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
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
    clearInterval(slackConversationReaper);
    realtimeAudio?.close();
    try { await slackSocketClient?.disconnect(); }
    catch (error) { console.error('slack_socket_shutdown_failed', error instanceof Error ? error.name : 'unknown'); }
    slackSocketConnected = false;
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
