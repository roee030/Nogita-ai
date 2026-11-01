import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { NogitaEngine, type Speculation } from '../core/engine.ts';
import { DemoMeeting } from '../adapters/demo.ts';
import { RecallMeeting } from '../adapters/recall.ts';
import { AttendeeMeeting } from '../adapters/attendee.ts';
import { SlackThreadMeeting, verifySlackSignature } from '../adapters/slack.ts';
import { createDependencies, loadDotEnv, researchFeatures } from './config.ts';
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
import { AttendeeRealtimeAudioHub, DEFAULT_EAGER_EOT_THRESHOLD, chooseSttMode, parseLanguages } from './attendee-realtime-audio.ts';
import { notifyBeforeCleanup } from './attendee-lifecycle.ts';
import { PresenceHub } from './presence.ts';
import { buildTurnTrace, TurnLog, parseTurnLogMode } from './turn-log.ts';
import { FileMissionStore } from './mission-store.ts';
import { MissionRunner, OPEN_MISSION, type Mission } from '../core/missions.ts';
import { buildToolbox } from '../core/agent-tools.ts';
import type { ActionReceipt } from '../core/contracts.ts';
import { directlyAddressesNogita, normalizeWakeWord } from '../core/policy.ts';
import { readFileSync } from 'node:fs';
import { StateStorageError, claimStateDirectory, persistentStateRequired } from './state-storage.ts';
import { FileMeetingMemory } from './meeting-memory.ts';
import { FileActionReceipts } from './action-receipts.ts';
import { acceptGitHubWebhook, GitHubRefreshQueue, githubWebhookConfigured } from './github-webhook.ts';

loadDotEnv();
const env = process.env;
const token = env.NOGITA_ADMIN_TOKEN;
const githubPushRefreshEnabled = env.NOGITA_GITHUB_PUSH_REFRESH === 'true';
if (!validAdminToken(token)) {
  throw new Error('Set a strong NOGITA_ADMIN_TOKEN in .env before starting server');
}
let providerConfigValid = true;
if (!githubWebhookConfigured(githubPushRefreshEnabled, env.GITHUB_WEBHOOK_SECRET)) {
  providerConfigValid = false;
  console.error('github_webhook_configuration_invalid');
}
const turnTakingV2 = env.NOGITA_TURN_TAKING_V2 === 'true';
if (env.NOGITA_TURN_TAKING_V2 !== undefined && !['true', 'false'].includes(env.NOGITA_TURN_TAKING_V2)) {
  providerConfigValid = false;
  console.error('turn_taking_v2_configuration_invalid');
}
let dependencies: ReturnType<typeof createDependencies>;
try {
  dependencies = createDependencies(env);
} catch (error) {
  providerConfigValid = false;
  // A tenant config error names the field (never a secret's value); provider constructor errors stay generic.
  console.error('provider_configuration_invalid', error instanceof Error && error.name === 'TenantConfigError' ? error.message : '');
  const safeEnv = { ...env, NOGITA_TENANT_CONFIG: '', BOARD_PROVIDER: 'demo', REPO_PROVIDER: 'demo', NOGITA_MODE: 'demo' };
  try {
    dependencies = createDependencies(safeEnv);
  } catch {
    dependencies = createDependencies({ ...safeEnv, IDENTITY_MAP_JSON: '[]' });
  }
}
if (dependencies.code.prepare) {
  void dependencies.code.prepare().catch(() => console.error('repository_index_warmup_failed'));
}
const githubRefreshQueue = new GitHubRefreshQueue(async sha => {
  const code = dependencies.code as typeof dependencies.code & { refreshIndex?(commitSha: string): Promise<void> };
  if (!code.refreshIndex || !providerConfigValid) throw new Error('GitHub index refresh unavailable');
  await code.refreshIndex(sha);
}, (error, sha) => console.error('repository_index_refresh_failed', JSON.stringify({ sha,
  error: error instanceof Error ? error.message : 'unknown error' })));
const attendeeHourlyPrice = Number(env.ATTENDEE_USD_PER_HOUR ?? '0.50');
const sessionBudgetEnabled = env.NOGITA_SESSION_BUDGET === 'true';
const sessionUsage = new SessionUsageRegistry(attendeeHourlyPrice, Date.now,
  Number(env.DEEPGRAM_NOVA3_MULTILINGUAL_USD_PER_MINUTE ?? '0.0058'),
  Number(env.DEEPGRAM_AURA2_USD_PER_THOUSAND_CHARACTERS ?? '0.03'), {
    enabled: sessionBudgetEnabled,
    maxModelCalls: Number(env.NOGITA_SESSION_MAX_MODEL_CALLS ?? '100'),
    maxEstimatedUsdPerHour: Number(env.NOGITA_SESSION_MAX_USD_PER_HOUR ?? '1'),
    warningRatio: Number(env.NOGITA_SESSION_BUDGET_WARNING_RATIO ?? '0.8'),
    log: event => console.warn(event.type, JSON.stringify(event)),
  });
const stateDirectory = env.NOGITA_STATE_DIR ?? '.nogita-state';
// A company cell does not start without persistent storage of its own; a .env setup only warns, as before.
// With an invalid config the demo stand-in runs to report the problem, so it claims nothing.
if (providerConfigValid) {
  try {
    if (claimStateDirectory(stateDirectory, dependencies.tenant.id, env).adopted) console.log('state_directory_adopted');
  } catch (error) {
    if (!(error instanceof StateStorageError)) throw error;
    if (error.kind === 'other_company' || persistentStateRequired(env)) throw error;
    console.error('state_storage_problem', error.message);
  }
}
const turnLog = new TurnLog(stateDirectory, parseTurnLogMode(env.NOGITA_TURN_LOG),
  env.ATTENDEE_WEBHOOK_SECRET ?? env.NOGITA_ADMIN_TOKEN ?? '');
const presence = new PresenceHub({ boardName: dependencies.board.name, chatName: dependencies.chat?.name,
  // A key derived from the webhook secret survives a restart, so the shared page reconnects instead of failing.
  ...(env.ATTENDEE_WEBHOOK_SECRET ? { keySecret: env.ATTENDEE_WEBHOOK_SECRET } : {}),
  onState: (sessionId, snapshot) => turnLog.record(sessionId, { type: 'ui', state: snapshot.state, status: snapshot.status, open: snapshot.open }),
  onStale: (sessionId, id) => turnLog.record(sessionId, { type: 'stale_question', id }) });
/**
 * Delegated missions: durable (NOGITA_STATE_DIR/missions), independent of any meeting, resumed after a restart.
 * Reads run on their own with the owner's access; every write waits for the owner's approval.
 */
/** Opt-in: receipts of writes kept in NOGITA_STATE_DIR, so a retry after a restart does not write them again. */
const actionReceipts: Map<string, ActionReceipt> = env.NOGITA_DURABLE_RECEIPTS === 'true'
  ? new FileActionReceipts(stateDirectory) : new Map();
const missionCompleted = actionReceipts;
const missionRunner = dependencies.agent ? new MissionRunner({ model: dependencies.agent, store: new FileMissionStore(stateDirectory),
  toolbox: (mission, callId) => buildToolbox({ actor: { id: mission.owner.id, displayName: mission.owner.displayName, verified: true },
    request: mission.goal, sessionId: `mission-${mission.id}`, eventId: callId ?? `${mission.id}:${mission.rounds}`,
    policy: dependencies.policy, code: dependencies.code, board: dependencies.board, chat: dependencies.chat, people: dependencies.people,
    completed: missionCompleted, writesApproved: true,
    onReceipt: receipt => notifyMission(mission, `${mission.id}: ${receipt.label}: ${receipt.url}`) }).toolbox,
  notify: (mission, text) => notifyMission(mission, text),
  onChange: mission => {
    if (mission.sessionId) {
      showMission(mission.sessionId);
      turnLog.record(mission.sessionId, { type: 'mission', id: mission.id, status: mission.status, ...(mission.activity ? { activity: mission.activity } : {}) });
    }
  } }) : undefined;

/** Progress goes to the meeting or thread it came from while that is open, else to NOGITA_MISSION_CHANNEL if set. */
async function notifyMission(mission: Mission, text: string): Promise<void> {
  if (mission.sessionId && await nogita.announce(mission.sessionId, text)) return;
  const channel = env.NOGITA_MISSION_CHANNEL;
  if (channel && dependencies.chat) { await dependencies.chat.postMessage(channel, text); return; }
  console.log('mission_update', mission.id, mission.status);
}

/** The presence screen shows the meeting's most relevant open mission (one waiting for approval first). */
function showMission(sessionId: string): void {
  const open = missionRunner?.list({ sessionId, open: true }) ?? [];
  const mission = open.find(m => m.status === 'awaiting_approval') ?? open.find(m => m.status === 'blocked') ?? open[0];
  presence.mission(sessionId, mission && { id: mission.id, goal: mission.goal, status: mission.status,
    ...(mission.activity ? { activity: mission.activity } : {}), ...(mission.pending ? { pending: mission.pending.summary } : {}) });
}

/** Meeting participants by session (participant uuid -> mapped to a team member), for who can see the shared screen. */
const participantsBySession = new Map<string, Map<string, boolean>>();
// In Attendee meetings the presence page is her webcam (a normal participant tile) unless NOGITA_PRESENCE says
// screenshare or off. Attendee mixes the (silent) page audio with our realtime speech, so the voice path is unchanged.
const presenceMode = env.NOGITA_PRESENCE === 'off' ? undefined : env.NOGITA_PRESENCE === 'screenshare' ? 'screenshare' as const : 'camera' as const;
const publicBaseUrl = (() => {
  try { return new URL(env.NOGITA_PUBLIC_URL || env.ATTENDEE_WEBHOOK_URL || '').origin; } catch { return undefined; }
})();
const presencePage = readFileSync(new URL('./presence-page.html', import.meta.url), 'utf8');
const meetingMemory = env.NOGITA_MEETING_MEMORY === 'decisions'
  ? new FileMeetingMemory(stateDirectory, Number(env.NOGITA_MEETING_MEMORY_DAYS || 90)) : undefined;
const nogita = new NogitaEngine({ ...dependencies, usage: sessionUsage, memory: meetingMemory },
  { handRaiseFallback: env.NOGITA_HAND_RAISE_FALLBACK === 'chat' ? 'chat' : 'none',
    floor: { talkingMs: turnTakingV2 ? 3_000 : 1_000, explicitTurnEnd: turnTakingV2 },
    actionItemRecap: env.NOGITA_ACTION_ITEM_RECAP === 'true',
    research: researchFeatures(env),
    receipts: actionReceipts,
    onQuestion: (sessionId, event) => {
      presence.question(sessionId, event);
      turnLog.record(sessionId, { type: 'question', id: event.id, status: event.status, speaker: turnLog.person(event.speaker),
        inputTurnIds: event.inputTurnIds,
        ...(event.detail ? { detail: event.detail } : {}), request: event.request });
    },
    onScreen: (sessionId, card) => presence.show(sessionId, card),
    onActivity: (sessionId, activity) => {
      if (activity.kind === 'tool') {
        presence.tool(sessionId, activity.questionId, activity.tools);
        turnLog.record(sessionId, { type: 'tool', ...(activity.questionId !== undefined ? { id: activity.questionId } : {}), tools: activity.tools });
      } else if (activity.kind === 'model_first_text') {
        turnLog.record(sessionId, { type: 'model_first_text',
          ...(activity.questionId !== undefined ? { id: activity.questionId } : {}), step: activity.step, ms: activity.ms });
      } else if (activity.kind === 'agent_trace') {
        turnLog.record(sessionId, buildTurnTrace({ ...(activity.questionId !== undefined ? { id: activity.questionId } : {}),
          model: activity.model, ms: activity.ms, result: activity.result, toolUses: activity.toolUses, stepMs: activity.stepMs,
          ...(activity.error ? { error: activity.error } : {}) }));
        sessionUsage.report(sessionId, dependencies.brain.usageFor?.(sessionId));
      } else presence.waiting(sessionId, activity.waiting);
    },
    onSpeech: (sessionId, event) => turnLog.record(sessionId, { type: 'speech', id: event.questionId, playbackId: event.playbackId, phase: event.phase,
      ...(event.outcome ? { outcome: event.outcome } : {}), ...(event.heardMs !== undefined ? { heardMs: event.heardMs } : {}) }),
    ...(missionRunner ? { missions: missionRunner } : {}),
    // The model already said goodbye in its reply.
    onLeaveRequested: sessionId => { void leaveMeeting(sessionId, { goodbye: false }); },
    screenAudience: sessionId => {
      const participants = participantsBySession.get(sessionId);
      return participants ? { unverified: [...participants.values()].filter(verified => !verified).length } : undefined;
    } });
const allowedSlackTeams = new Set((env.SLACK_ALLOWED_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const meetingHandles = new Map<string, DemoMeeting>();
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
const meetingLanguages = parseLanguages(env.NOGITA_LANGUAGES);
const stt = chooseSttMode(env.DEEPGRAM_STT_MODE, meetingLanguages);
// Flux would silently lose Hebrew: refuse it and keep Nova-3 multilingual.
if (stt.refused) console.error('flux_disabled_language_unsupported', stt.refused);
const fluxStt = stt.mode === 'flux-english';
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
    const startedAt = Date.now();
    let result = 'error';
    try {
      result = await nogita.onUtterance(sessionId, utterance, { speakerKey: context.speakerKey,
        ...(context.speculation ? { speculation: context.speculation as Speculation } : {}),
        ...(context.turnEnded ? { turnEnded: true } : {}) });
    } finally {
      turnLog.record(sessionId, { type: 'turn', speaker: turnLog.person(utterance.actor.displayName),
        addressed: directlyAddressesNogita(utterance.text), words: utterance.text.trim().split(/\s+/).length, result,
        ms: Date.now() - startedAt, text: utterance.text });
    }
  },
  async (sessionId, message) => {
    const meeting = attendeeMeetingsBySession.get(sessionId);
    if (!meeting) throw new Error('unknown Attendee meeting');
    await meeting.sendStatus(message, 1_500);
  },
  { onError: error => console.error('attendee_command_failed', error instanceof Error ? error.message : 'unknown'),
    onChatAck: (sessionId, durationMs) => sessionUsage.recordResponseStage(sessionId, 'transcript_to_chat_ack', durationMs),
    onSpeechActivity: (sessionId, speakerUuid) => nogita.cancelProgressForSpeechActivity(sessionId, speakerUuid),
    onTurnEnded: (sessionId, speakerUuid) => nogita.noteTurnEnded(sessionId, speakerUuid),
    explicitTurnEnd: turnTakingV2,
    chatAck: !realtimeAudioEnabled,
    incompleteTurnHoldMs: Number(env.NOGITA_INCOMPLETE_TURN_HOLD_MS || 0),
    earlyCommitMs: Number(env.NOGITA_EARLY_COMMIT_MS || 0),
    ...(fluxStt && env.DEEPGRAM_EAGER_EOT_THRESHOLD !== 'off'
      ? { speculate: (sessionId: string, utterance: Utterance) => nogita.speculate(sessionId, utterance) } : {}),
    onLeave: sessionId => leaveMeeting(sessionId, { goodbye: true }) },
);

const leavingSessions = new Set<string>();
const GOODBYES = ['Sure, bye everyone.', 'Okay, bye everyone.', 'Sure thing. Bye, everyone.'];

/** Says goodbye (unless the model already did), leaves the call, then forgets the session. */
async function leaveMeeting(sessionId: string, { goodbye }: { goodbye: boolean }): Promise<void> {
  if (leavingSessions.has(sessionId)) return;
  leavingSessions.add(sessionId);
  try {
    const meeting = attendeeMeetingsBySession.get(sessionId);
    const botId = meeting?.botIdentifier ?? attendeeBotsBySession.get(sessionId);
    // Whatever she was saying stops now; the goodbye must not wait behind a long answer.
    meeting?.interruptSpeech?.();
    if (meeting && goodbye) {
      const line = GOODBYES[Math.floor(Math.random() * GOODBYES.length)]!;
      // A goodbye that cannot play within a few seconds must not keep her in the call.
      const said = await Promise.race([meeting.speak(line).then(() => true, () => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 4_000))]);
      if (!said) await meeting.sendStatus(line).catch(() => console.error('leave_acknowledgement_failed'));
    }
    try {
      // The engine may not know the session (it was never restored, or already ended); the bot must still leave.
      if (nogita.hasSession(sessionId)) await nogita.endSession(sessionId);
      else await meeting?.leave();
    } catch {
      if (meeting) {
        try { await meeting.sendStatus('I couldn’t leave the call just now. Ask me again, or remove me from the meeting.'); }
        catch { console.error('leave_failure_notice_failed'); }
      }
      return;
    }
    sessionUsage.end(sessionId);
    await forgetAttendeeSession(sessionId, botId);
  } finally {
    leavingSessions.delete(sessionId);
  }
}

let realtimeAudio: AttendeeRealtimeAudioHub | undefined;
if (realtimeAudioEnabled && env.ATTENDEE_AUDIO_WEBSOCKET_URL && env.DEEPGRAM_API_KEY && env.ATTENDEE_WEBHOOK_SECRET) {
  try { realtimeAudio = new AttendeeRealtimeAudioHub({
      baseUrl: env.ATTENDEE_AUDIO_WEBSOCKET_URL,
      signingSecret: env.ATTENDEE_WEBHOOK_SECRET,
      deepgramApiKey: env.DEEPGRAM_API_KEY,
      deepgramMipOptOut: env.DEEPGRAM_MIP_OPT_OUT !== 'false',
      sttMode: stt.mode, languages: meetingLanguages,
      ttsModel: env.DEEPGRAM_TTS_MODEL, warmSpeech: true, turnTakingV2,
      ...(env.DEEPGRAM_EOT_THRESHOLD ? { fluxEndOfTurnThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD) } : {}),
      ...(env.DEEPGRAM_EAGER_EOT_THRESHOLD !== 'off'
        ? { fluxEagerEndOfTurnThreshold: Number(env.DEEPGRAM_EAGER_EOT_THRESHOLD || DEFAULT_EAGER_EOT_THRESHOLD) } : {}),
      onTranscript: async (sessionId, participantUuid, text, participant, recognition) => {
        const request = transcriptRequest(sessionId, participantUuid, text, participant, recognition?.inputTurnId);
        turnLog.record(sessionId, { type: 'heard', speaker: turnLog.person(request.utterance.actor.displayName),
          inputTurnId: recognition?.inputTurnId,
          addressed: directlyAddressesNogita(normalizeWakeWord(text)), verified: request.utterance.actor.verified,
          words: text.trim().split(/\s+/).length, ...(recognition?.confidence !== undefined ? { confidence: recognition.confidence } : {}), text });
        if (fluxStt) await attendeeCommands.acceptCompletedTurn(request);
        else await attendeeCommands.acceptFinal(request);
      },
      onSpeechActivity: (sessionId, participantUuid) => attendeeCommands.noteSpeechActivity(sessionId, participantUuid),
      onEagerTranscript: (sessionId, participantUuid, text, participant, inputTurnId) => {
        // A wake-word transcript is strong speech evidence even when the conservative level gate misses a quiet
        // opening word. Hold the floor between answer pieces; acoustic cancellation still uses the own-voice gate.
        if (directlyAddressesNogita(normalizeWakeWord(text))) attendeeCommands.noteSpeechActivity(sessionId, participantUuid);
        attendeeCommands.acceptEagerTurn(transcriptRequest(sessionId, participantUuid, text, participant, inputTurnId));
      },
      onTurnResumed: (sessionId, participantUuid) => attendeeCommands.resumeTurn(sessionId, participantUuid),
      onTurnTiming: (sessionId, participantUuid, event) => {
        turnLog.record(sessionId, { type: 'eot', speaker: turnLog.person(participantUuid), ...event });
        if (turnTakingV2 && event.phase === 'confirmed') nogita.noteTurnEnded(sessionId, participantUuid);
      },
      onVoice: (sessionId, participantUuid) => {
        nogita.noteVoice(sessionId, participantUuid);
        attendeeCommands.noteOwnVoice(sessionId, participantUuid);
        presence.voice(sessionId, participantUuid);
      },
      onInterim: (sessionId, participantUuid, text) => {
        if (directlyAddressesNogita(text)) presence.addressed(sessionId, participantUuid);
      },
      onInputLevel: (sessionId, rms) => presence.inputLevel(sessionId, rms),
      onOutputAudio: (sessionId, pcm) => presence.outputAudio(sessionId, pcm),
      onSpeechStart: (sessionId, trace) => turnLog.record(sessionId, { type: 'audio', phase: 'start',
        id: trace.questionId, playbackId: trace.playbackId, ttfaMs: trace.ttfaMs }),
      onSpeechEnd: (sessionId, end) => {
        presence.speechEnded(sessionId);
        turnLog.record(sessionId, { type: 'audio', phase: 'end', outcome: end.outcome, playedMs: end.playedMs,
          id: end.questionId, playbackId: end.playbackId });
      },
      onInterrupt: (sessionId, interrupt) => turnLog.record(sessionId, { type: 'interrupt', cause: interrupt.cause,
        id: interrupt.questionId, playbackId: interrupt.playbackId,
        playedMs: interrupt.playedMs, ...(interrupt.latencyMs !== undefined ? { latencyMs: interrupt.latencyMs } : {}) }),
      onSpeechPause: (sessionId, pause) => turnLog.record(sessionId, { type: 'audio_pause',
        id: pause.questionId, playbackId: pause.playbackId, playedMs: pause.playedMs, latencyMs: pause.latencyMs }),
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
  participant?: { attendeeUserUuid?: string; displayName?: string }, inputTurnId?: string) {
  const mapped = participant?.attendeeUserUuid
    ? dependencies.identities.fromAttendee(participant.attendeeUserUuid) : undefined;
  return { sessionId, botId: attendeeBotsBySession.get(sessionId) ?? '',
    speakerUuid: participantUuid, ...(participant?.attendeeUserUuid ? { attendeeUserUuid: participant.attendeeUserUuid } : {}),
    utterance: { eventId: `realtime-${randomUUID()}`,
      ...(inputTurnId ? { inputTurnIds: [inputTurnId] } : {}),
      actor: mapped ? { id: mapped.id, displayName: mapped.displayName, verified: true }
        : { id: `unmapped:attendee:${participant?.attendeeUserUuid ?? participantUuid}`,
          displayName: participant?.displayName ?? 'Meeting participant', verified: false },
      text, at: Date.now() } };
}

async function forgetAttendeeSession(sessionId: string, botId?: string): Promise<void> {
  turnLog.record(sessionId, { type: 'session', phase: 'end' });
  participantsBySession.delete(sessionId);
  presence.close(sessionId);
  attendeeCommands.endSession(sessionId);
  attendeeMeetingsBySession.delete(sessionId);
  attendeeBotsBySession.delete(sessionId);
  realtimeAudio?.closeSession(sessionId);
  if (botId) await attendeeBindings.remove(sessionId, botId);
}

/** Who is in the call, for the shared-screen check. Nogita's own bot is not an audience member. */
function noteParticipant(sessionId: string, participantUuid: string, eventType: 'join' | 'leave', attendeeUserUuid?: string, displayName?: string): void {
  const participants = participantsBySession.get(sessionId) ?? new Map<string, boolean>();
  participantsBySession.set(sessionId, participants);
  if (eventType === 'leave') { participants.delete(participantUuid); return; }
  if (displayName?.trim().toLowerCase() === 'nogita') return;
  participants.set(participantUuid, Boolean(attendeeUserUuid && dependencies.identities.fromAttendee(attendeeUserUuid)));
}

function restoreAttendeeSession(sessionId: string, botId: string): void {
  if (nogita.hasSession(sessionId)) return;
  const meeting = new AttendeeMeeting(sessionId, env.ATTENDEE_API_KEY ?? '',
    env.ATTENDEE_PRIVACY_REVIEWED === 'true', fetch, env.ATTENDEE_WEBHOOK_URL, undefined, synthesizeLocalMp3,
    (stage, durationMs) => sessionUsage.recordSpeechStage(sessionId, stage, durationMs), undefined,
    realtimeAudio ? (text, options) => realtimeAudio.speak(sessionId, text, options) : undefined, undefined,
    realtimeAudio ? () => realtimeAudio.interruptSpeech(sessionId) : undefined);
  meeting.attach(botId);
  nogita.restoreSession(sessionId, meeting);
  // The shared page keeps its URL across a restart (derived key): reopen its state so it reconnects.
  if (presenceMode) { presence.open(sessionId); showMission(sessionId); }
  turnLog.record(sessionId, { type: 'session', phase: 'restore' });
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
        noteParticipant(participant.sessionId, participant.participantUuid, participant.eventType, participant.attendeeUserUuid, participant.displayName);
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
    if (req.method === 'GET' && pathname === '/version') {
      respond(res, 200, { sha: env.RENDER_GIT_COMMIT ?? null }); return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      respond(res, 200, { ok: true, service: 'nogita', sessions: nogita.sessionCount() }); return;
    }
    // Mission dashboard data (admin token): every mission with its status and history, without the model transcript.
    const missionMatch = pathname.match(/^\/missions(?:\/(M-[A-Z0-9]{1,20}))?$/);
    if (req.method === 'GET' && missionMatch) {
      if (!safeToken(req.headers.authorization)) { respond(res, 401, { error: 'unauthorized' }); return; }
      const view = ({ messages: _messages, pending, ...mission }: Mission) =>
        ({ ...mission, ...(pending ? { pending: { tool: pending.tool, summary: pending.summary, requestedAt: pending.requestedAt } } : {}) });
      if (missionMatch[1]) {
        const mission = missionRunner?.get(missionMatch[1]);
        if (!mission) { respond(res, 404, { error: 'unknown mission' }); return; }
        respond(res, 200, view(mission)); return;
      }
      respond(res, 200, { missions: (missionRunner?.list() ?? []).map(m => ({ ...view(m), steps: m.steps.slice(-5) })),
        open: (missionRunner?.list() ?? []).filter(m => OPEN_MISSION.has(m.status)).length }); return;
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
    if (githubPushRefreshEnabled && req.method === 'POST' && pathname === '/webhooks/github') {
      const raw = await readRaw(req);
      const result = acceptGitHubWebhook({
        secret: env.GITHUB_WEBHOOK_SECRET ?? '', raw,
        signature: req.headers['x-hub-signature-256'] as string | undefined,
        event: req.headers['x-github-event'] as string | undefined,
        expected: { owner: env.GITHUB_OWNER ?? '', repo: env.GITHUB_REPO ?? '', ref: env.GITHUB_REF ?? 'main' },
        refresh: sha => githubRefreshQueue.enqueue(sha),
      });
      respond(res, result.status, result.response); return;
    }
    if (!safeToken(req.headers.authorization)) { respond(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && pathname === '/api/connections') {
      const report = await probeConnections(env);
      respond(res, report.ok ? 200 : 503, report); return;
    }
    if (req.method === 'GET' && pathname === '/api/readiness') {
      const report = buildReadinessReport(env, dependencies.identities, process.versions.node,
        providerConfigValid, slackSocketConnected, env.NOGITA_TENANT_CONFIG?.trim() ? dependencies.connections : undefined);
      if (!githubPushRefreshEnabled) { respond(res, report.ok ? 200 : 503, report); return; }
      const code = dependencies.code as typeof dependencies.code & {
        indexStatus?(): Promise<{ indexedSha?: string; headSha: string; current: boolean }>;
      };
      const repositoryIndex = await code.indexStatus?.().catch(() => undefined);
      const ready = report.ok && repositoryIndex?.current === true;
      respond(res, ready ? 200 : 503, { ...report, ok: ready,
        repositoryIndex: repositoryIndex ?? { current: false, error: 'unavailable' } }); return;
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
        ? `${publicBaseUrl}/presence/${encodeURIComponent(payload.id)}?k=${presence.open(payload.id)}${presenceMode === 'camera' ? '&view=camera' : ''}` : undefined;
      const meeting = provider === 'recall'
        ? new RecallMeeting(payload.id, env.RECALL_API_KEY ?? '', env.RECALL_REGION ?? 'us-east-1')
        : provider === 'attendee'
        ? new AttendeeMeeting(payload.id, env.ATTENDEE_API_KEY ?? '', env.ATTENDEE_PRIVACY_REVIEWED === 'true',
            fetch, env.ATTENDEE_WEBHOOK_URL, attendeeChallenge
              ? `To verify your identity for this meeting, please say: ${attendeeChallenge}`
              : undefined, synthesizeLocalMp3,
            (stage, durationMs) => sessionUsage.recordSpeechStage(payload.id!, stage, durationMs),
            realtimeAudioUrl, realtimeAudio ? (text, options) => realtimeAudio.speak(payload.id!, text, options) : undefined,
            presencePageUrl && presenceMode ? { url: presencePageUrl, mode: presenceMode } : undefined,
            realtimeAudio ? () => realtimeAudio.interruptSpeech(payload.id!) : undefined)
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
      turnLog.record(payload.id, { type: 'session', phase: 'start' });
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
// Missions that were working when the server stopped go on from their last saved step.
void missionRunner?.resumeAll().then(count => { if (count) console.log('missions_resumed', count); })
  .catch(() => console.error('missions_resume_failed'));
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
