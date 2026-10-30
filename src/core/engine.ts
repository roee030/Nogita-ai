import { CodeLookupRateLimitError, SpeechFallbackSentError, SpeechInterruptedError, type ScreenCard, type ActionReceipt, type BoardPort, type BrainPort, type ChatPort, type CodePort, type ConversationTurn, type Evidence,
  type MeetingPort, type PolicyPort, type SpeakOptions, type UsagePort, type Utterance } from './contracts.ts';
import { runAgent, type ChatModel } from './agent.ts';
import { buildToolbox, type MissionPort, type PeopleDirectory } from './agent-tools.ts';
import { OPEN_MISSION, type MissionRunner } from './missions.ts';
import { agentUserMessage, stableAgentPrompt, turnAgentPrompt } from './agent-prompt.ts';
import { SpeechFloor, type SpeakResult, type SpeechFloorOptions } from './speech-floor.ts';
import { PhrasePicker, toSpoken } from './spoken.ts';
import { directlyAddressesNogita, isExplicitCreateRequest, isExplicitLeaveRequest, isExplicitPRRequest,
  isRepositoryConnectionQuestion, isRepositoryOverviewQuestion, isRepositoryQuestion, removeAddress } from './policy.ts';

interface Session {
  meeting: MeetingPort;
  history: ConversationTurn[]; // ephemeral: purged when session ends
  /** `conversation`: she just answered and the asker may go on without her name; it closes when someone else talks.
   *  `question`: she asked the speaker something and waits for the reply. */
  pendingFollowUp?: { actorId: string; request: string; question: string; expiresAt: number; afterSequence: number;
    kind?: 'question' | 'conversation'; intervened?: boolean };
  /** Someone said only her name ("Nogita."); their next words are for her even without it. */
  calledBy?: { actorId: string; until: number };
  /** People heard recently (actor id -> last time), to tell a one-to-one call from a group. */
  heard?: Map<string, number>;
  /** First names of people heard (actor id -> name), to tell when someone is addressed by name instead of her. */
  names?: Map<string, string>;
  activeRequest?: { actorId: string; request: string; startedAt: number; firstSpeechRecorded: boolean };
  lastArrivalSequence: number;
  eventIds: Set<string>;
  raised: boolean;
  /** Why Nogita raised her hand; told to the agent when someone gives her the floor. */
  raisedReason?: string;
  lastAssessmentAt: number;
  utterancesSinceAssessment: number;
  assessing: boolean;
  mutedUntil: number;
  processing: Promise<void>;
  ending: boolean;
  endingPromise?: Promise<void>;
  progressTimer?: unknown;
  progressSpeech?: Promise<void>;
  lastProgressPhrase?: string;
  /** Keeps the agent's prompt cache warm between questions in a voice meeting. */
  cacheTimer?: ReturnType<typeof setTimeout>;
  lastModelCallAt: number;
  /** Voice meetings: questions being looked up or answered, each on its own, sharing one voice. */
  questions: Question[];
  nextQuestionId: number;
  floor?: SpeechFloor;
}

export type QuestionStatus = 'speculative' | 'working' | 'answering' | 'interrupted' | 'answered' | 'chat_only' |
  'cancelled' | 'stopped' | 'failed' | 'rolled_back' | 'superseded' | 'duplicate';
/** One question to Nogita in a voice meeting, tracked from the moment it is heard until it is answered or dropped. */
interface Question {
  id: number;
  actorId: string;
  speaker: string;
  request: string;
  /** Normalized words, to spot the same question asked twice. */
  key: string;
  askedAt: number;
  startedAt: number;
  status: QuestionStatus;
  /** A few words naming what it is about ("the login bug"), when another question overlaps it. */
  topic?: string;
  topicPending?: boolean;
  /** Another question was asked while this one was open: name the topic before the answer. */
  needsLabel: boolean;
  labelled: boolean;
  /** The agent was told about the other open questions and names its topic itself. */
  agentNamesTopic: boolean;
  abort: AbortController;
  /** Opens when the question is confirmed; a speculative start speaks and writes nothing before that. */
  gate: Promise<void>;
  commit: () => void;
  run?: Promise<ProcessResult | undefined>;
  progressTimer?: unknown;
  firstSpeechRecorded: boolean;
  queuedSpeech: boolean;
  interruptions: number;
  /** When a participant last cut this answer off. */
  interruptedAt?: number;
}
export interface QuestionEvent {
  id: number; status: QuestionStatus; speaker: string; request: string; topic?: string; detail?: string;
}
/** Handle for a question started before the end of the speaker's turn was confirmed. */
export interface Speculation { readonly sessionId: string; readonly question: unknown; cancel(): void }
type ProgressWork = () => void | Promise<void>;
export interface NogitaEngineOptions {
  progressDelayMs?: number;
  /** Filler delay when the streaming agent answers; its own spoken lead-in usually comes first. */
  agentProgressDelayMs?: number;
  /** Where platforms cannot raise a hand natively: 'chat' posts a short hand-raise line, 'none' stays silent. */
  handRaiseFallback?: 'none' | 'chat';
  /** Minimum gap between proactive assessments in one meeting. */
  assessmentIntervalMs?: number;
  schedule?: (work: ProgressWork, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  random?: () => number;
  now?: () => number;
  /** Every change in a voice question's status (the voice lab logs them). */
  onQuestion?: (sessionId: string, event: QuestionEvent) => void;
  /** What she is doing right now, for the presence screen: a tool a question runs, or an answer waiting for a pause. */
  /** Puts a card on the meeting's presence screen (undefined clears it); enables the show_on_screen tool. */
  onScreen?: (sessionId: string, card: ScreenCard | undefined) => void;
  onActivity?: (sessionId: string, activity: { kind: 'tool'; questionId?: number; tools: string[] } | { kind: 'waiting'; waiting: boolean }) => void;
  /** A piece of a voice answer starts or ends playing (with how it ended), for per-turn diagnostics. */
  onSpeech?: (sessionId: string, event: { questionId: number; phase: 'start' | 'end'; outcome?: string; heardMs?: number }) => void;
  /** Who can see the shared screen (participants not mapped to a team member); gates show_on_screen. */
  screenAudience?: (sessionId: string) => { unverified: number } | undefined;
  /** Delegated missions: enables delegate_mission, missions_status and decide_mission for authorized people. */
  missions?: MissionRunner;
  /** Someone asked her to leave in words the fast check missed; called once the reply is over (enables leave_meeting). */
  onLeaveRequested?: (sessionId: string) => void;
  /** Speech floor timing (tests use shorter waits). */
  floor?: Pick<SpeechFloorOptions, 'talkingMs' | 'resumeAfterMs' | 'staleLeadInMs' | 'maxWaitMs' | 'holdMs' | 'schedule' | 'cancel'>;
}

/** "Stop", "wait", "hold on": stop talking now (the answer stays in chat). */
export function isStopCommand(text: string): boolean {
  if (isPlainStop(text)) return true;
  // Said while she talks over someone: "Stop stop for a second!", "Hello, I'm talking to you, stop.", "Stop speaking."
  if (text.trim().endsWith('?')) return false;
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\b(?:nogitas?|no gita|hey|hello)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8 || /^(?:how|what|why|where|when|who|which|can|could|should|do|does|did|is|are)\b/.test(t)) return false;
  return /\b(?:stop|be quiet|shut up|enough|hold on|hang on)\b/.test(t) &&
    !/\b(?:don't|do not|not|never) stop\b|\bstop (?:the|a|an|this|that|my|our|your)\b/.test(t);
}
/** A barge-in may contain both the control and what to do next: "stop. Just tell me ...". */
function splitLeadingStop(text: string): { stop: string; remainder: string } | undefined {
  const match = text.trim().match(/^((?:(?:ok(?:ay)?|no|sorry|please)[,.]?\s+)?(?:stop|wait|hold on|hang on|enough|that's enough)(?:\s+(?:please|now|talking|a sec(?:ond)?|for a sec(?:ond)?|there))?)[.!,:;-]+\s*(.+)$/i);
  if (!match || !isStopCommand(match[1]!)) return undefined;
  return { stop: match[1]!, remainder: match[2]!.trim() };
}
function isPlainStop(text: string): boolean {
  return /^(?:(?:ok(?:ay)?|no|sorry|please)[,.]?\s+)?(?:stop|wait|hold on|hang on|enough|that's enough)(?:\s+(?:please|now|talking|a sec(?:ond)?|for a sec(?:ond)?|there))?[.!]?$/i
    .test(text.trim());
}
/** "Never mind", "forget it", "cancel that": drop the open question. */
export function isCancelCommand(text: string): boolean {
  return /^(?:(?:ok(?:ay)?|oh|actually|no|ah|um|uh)[,.]?\s+)*(?:never ?mind|forget (?:it|that|about (?:it|that))|cancel (?:it|that|the (?:question|lookup|search))|scratch that|drop (?:it|that)|no need|don't worry about (?:it|that))(?:[,.]?\s+(?:then|please|nogita|i found it|we're good|i got it))?[.!]?$/i
    .test(text.trim());
}
function questionKey(text: string): string {
  return text.toLowerCase().replace(/^(?:and|also|so|okay|ok)\s+/, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
export const OVERLAP_PROGRESS = ['Checking that too.', 'On it, one sec.', 'Looking into that too.'];

function isAffirmativeFollowUp(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[,]+/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:yes|yes please|yeah|yeah please|sure|sure please|please do|go ahead|i want to know(?: the answer(?: to (?:that|the question))?)?|i would like to know(?: the answer)?)$/.test(normalized);
}

// The agent usually speaks its own lead-in first; when it is late, a filler must be short, because the
// answer queues behind it (the voice lab measured a 2 s filler delaying a ready answer by 2 s).
// They must not promise a lookup: the model may answer from what it knows (the judge flagged a "Let me check" with none).
export const agentProgressPhrases = ['One sec.', 'Hmm, one moment.', 'Mm, let me think.', 'Good one, one sec.', 'Hmm.'];

export const progressPhrases = [
  'Hmm, let me think.',
  'One sec, checking.',
  'Give me a second.',
  'Okay, let me look.',
  'Hang on, looking.',
  'Let me pull that up.',
  'Mm, one moment.',
];
/** When the spoken cap is reached; the whole answer is in the chat. */
export const REST_IN_CHAT = ['The rest is in the chat.', 'I put the details in the chat.', 'More in the chat.'];
function missingCodeEvidenceMessage(code: CodePort): string {
  const skipped = code.getCoverage?.()?.skippedLargeFiles ?? 0;
  return 'I could not find enough code evidence to answer that reliably.' +
    codeCoverageNotice(skipped);
}
function codeCoverageNotice(skipped: number): string {
  return skipped > 0 ? ` ${skipped} large ${skipped === 1 ? 'file was' : 'files were'} not searched.` : '';
}
function withCodeCoverageNotice(code: CodePort, message: string): string {
  return message + codeCoverageNotice(code.getCoverage?.()?.skippedLargeFiles ?? 0);
}
/** Spoken answers are short by default (the prompt asks for one or two sentences); this is the hard cap. */
const MAX_SPOKEN_WORDS = 60;
/** When they ask for detail ("in three sentences", "walk me through"), the cap gives the answer room. */
const DETAIL_SPOKEN_WORDS = 120;
function wantsDetail(request: string): boolean {
  return /\b(?:in (?:two|three|four|five|a few) sentences|walk (?:me|us) through|step by step|in detail|explain (?:how|why)|tell me more|go into detail|elaborate)\b/i.test(request);
}
export const STILL_WORKING = ['Still digging, one more sec.', 'Almost there.', 'Still on it.', 'Nearly got it.'];
/** Whole sentences up to about `max` words (at least the first sentence). */
function firstWords(text: string, max: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  let out = '';
  for (const sentence of sentences) {
    if (out && (out + sentence).split(/\s+/).length > max) break;
    out += sentence;
  }
  return out.trim();
}
/** "Yeah", "okay", "mm-hmm": listening noises, not a turn of their own. */
function isBackchannel(text: string): boolean {
  return /^(?:yeah|yes|yep|yup|ok(?:ay)?|right|sure|mm+(?:-?hmm)?|hmm+|uh[- ]?huh|got it|i see|cool|nice|great|exactly|true|go on)[.!,]?(?:\s+(?:yeah|ok(?:ay)?|right|sure))?[.!]?$/i.test(text.trim());
}
/** Courtesy closes the exchange; it is not a follow-up for the model to think about. */
function isCourtesyClose(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:nogita|נוגיטה)\s+)?(?:thanks|thank you|thanks a lot|many thanks|תודה|תודה רבה)(?:\s+(?:nogita|נוגיטה))?$/.test(t);
}
/** "Dana, ...", "... right, Dana?", "Guys, ...": the words are for someone else, not for her. */
export function addressesSomeoneElse(text: string, names: Iterable<string>): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const vocatives = ['guys', 'everyone', 'everybody', 'team', 'folks', 'you all', "y'all"];
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.length > 1 && n !== 'nogita') vocatives.push(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const who = `(?:${vocatives.join('|')})`;
  return new RegExp(`^(?:(?:hey|so|okay|ok|and|um|uh|well)[,\\s]+)?${who}[,:!?]`).test(t) ||
    new RegExp(`,\\s*${who}[.?!]*$`).test(t);
}
/** "No, I meant the mobile app", "Actually, I'm asking about staging": a correction of the speaker's own question. */
export function looksLikeCorrection(text: string): boolean {
  const t = text.trim();
  return /^(?:(?:no|nope|sorry|actually|wait)[,.!]?\s+)*(?:i meant|i mean|not that|i'm asking about|i am asking about|i was asking about|what i meant|i'm talking about|i was talking about)\b/i.test(t) ||
    /^(?:no|nope)[,.!]?\s+(?:the|for|in|on|about|not)\b/i.test(t);
}
/** Words that read as a question or a request (for a turn that did not use her name). */
function looksLikeRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || /^(?:(?:so|okay|ok|and|um|uh|well|now|hey|also|then)[,\s]+)*(?:what|what's|why|where|when|who|which|how|can|could|would|will|is|are|do|does|did|should|please|tell|show|share|open|create|add|give|list|find|check|explain|put|move|i want|i need|i'd like|let's)\b/.test(t);
}
/** True when the answer asks the listener something; instructions may follow the question. */
function asksQuestion(answer: string): boolean {
  // A quoted example (like "Nogita, how does auth work?") is not a question to the listener.
  const sentences = answer.trim().replace(/"[^"]*"|“[^”]*”/g, 'x').match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.some(sentence => sentence.trim().endsWith('?'));
}
/** Markdown and URLs read badly through text-to-speech; the chat copy keeps them. */
export type ProcessResult = 'ignored' | 'raised_hand' | 'answered' | 'completed' | 'denied' | 'not_supported';

export class NogitaEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly startingSessions = new Set<string>();
  private readonly completed = new Map<string, ActionReceipt>(); // Process-local; durable idempotency is TODO.
  private readonly progressDelayMs: number;
  private readonly agentProgressDelayMs: number;
  private readonly handRaiseFallback: 'none' | 'chat';
  private readonly assessmentIntervalMs: number;
  private repositoryMap?: { value?: { paths: string[]; readme?: string; revision?: string }; at: number; pending?: Promise<void> };
  private readonly schedule: (work: ProgressWork, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onQuestion?: NogitaEngineOptions['onQuestion'];
  private readonly onActivity?: NogitaEngineOptions['onActivity'];
  private readonly onScreen?: NogitaEngineOptions['onScreen'];
  private readonly onSpeech?: NogitaEngineOptions['onSpeech'];
  private readonly screenAudience?: NogitaEngineOptions['screenAudience'];
  private readonly missions?: MissionRunner;
  private readonly onLeaveRequested?: NogitaEngineOptions['onLeaveRequested'];
  private readonly phrases: PhrasePicker;
  private readonly floorOptions: NonNullable<NogitaEngineOptions['floor']>;
  constructor(private readonly dependencies: {
    board: BoardPort;
    code: CodePort;
    brain: BrainPort;
    policy: PolicyPort;
    usage?: UsagePort;
    /** Tool-using conversational model. When present it answers every direct request; the planner is the fallback. */
    agent?: ChatModel;
    chat?: ChatPort;
    people?: PeopleDirectory;
  }, options: NogitaEngineOptions = {}) {
    this.progressDelayMs = options.progressDelayMs ?? 1_000;
    this.agentProgressDelayMs = options.agentProgressDelayMs ?? 2_000;
    this.handRaiseFallback = options.handRaiseFallback ?? 'none';
    this.assessmentIntervalMs = options.assessmentIntervalMs ?? 45_000;
    this.schedule = options.schedule ?? ((work, delayMs) => setTimeout(() => { void work(); }, delayMs));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
    this.phrases = new PhrasePicker(this.random);
    this.now = options.now ?? Date.now;
    this.onQuestion = options.onQuestion;
    this.onActivity = options.onActivity;
    this.onScreen = options.onScreen;
    this.onSpeech = options.onSpeech;
    this.screenAudience = options.screenAudience;
    this.missions = options.missions;
    this.onLeaveRequested = options.onLeaveRequested;
    this.floorOptions = options.floor ?? {};
  }

  private validateSessionId(sessionId: string): void {
    if (!sessionId || sessionId.length > 100) throw new Error('invalid session id');
  }

  private addSession(sessionId: string, meeting: MeetingPort): void {
    this.validateSessionId(sessionId);
    this.dependencies.brain.beginUsageSession?.(sessionId);
    this.sessions.set(sessionId, {
      meeting, history: [], lastArrivalSequence: 0, eventIds: new Set(), raised: false, mutedUntil: 0,
      lastAssessmentAt: 0, utterancesSinceAssessment: 0, assessing: false,
      processing: Promise.resolve(), ending: false, lastModelCallAt: 0, questions: [], nextQuestionId: 1,
    });
    const session = this.sessions.get(sessionId)!;
    if (this.dependencies.agent && meeting.capabilities.has('speak')) {
      session.floor = new SpeechFloor({ ...this.floorOptions, now: this.now,
        speak: (text, owner) => this.floorSpeak(sessionId, session, text, owner),
        stopPlayback: () => { session.meeting.interruptSpeech?.(); },
        onInterrupted: owner => {
          const question = session.questions.find(q => q.id === owner);
          if (!question) return;
          // Repeating the same answer after a second interruption sounds like a stuck record: the rest is in chat.
          if (++question.interruptions > 1) {
            session.floor!.drop(owner);
            this.reportQuestion(sessionId, question, 'chat_only', 'cut off twice; the rest is in chat');
          } else {
            question.interruptedAt = this.now();
            this.setStatus(sessionId, session, owner, 'interrupted');
          }
        },
        onResumed: owner => this.setStatus(sessionId, session, owner, 'answering', 'resumed'),
        onWaiting: waiting => this.onActivity?.(sessionId, { kind: 'waiting', waiting }),
        onDrop: (owner, _text, reason) => {
          const question = session.questions.find(q => q.id === owner);
          if (question && reason === 'no_opening') this.setStatus(sessionId, session, owner, question.status, 'speech dropped: no opening');
        } });
    }
    this.keepAgentCacheWarm(sessionId);
  }

  /**
   * A voice meeting's first question waited about 1.5 s longer on a cold prompt cache (voice lab). The cache is
   * written when the session starts and read again before its 5-minute lifetime ends while the meeting is quiet.
   */
  private keepAgentCacheWarm(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const agent = this.dependencies.agent;
    if (!session || session.ending || !agent?.warmCache || !session.meeting.capabilities.has('speak')) return;
    const warm = async () => {
      if (this.now() - session.lastModelCallAt < 4 * 60_000) return;
      const repository = await this.repositoryOverview();
      if (this.sessions.get(sessionId) !== session || session.ending) return;
      // The tool list an authorized person gets; it is only described to the model here, never run.
      const { toolbox } = buildToolbox({
        actor: { id: 'cache-warmup', displayName: 'Nogita', verified: true }, request: '', sessionId, eventId: 'cache-warmup',
        policy: { mayReadCode: () => true, mayWriteTask: () => true, mayDraftPR: () => false },
        code: this.dependencies.code, board: this.dependencies.board, chat: this.dependencies.chat,
        people: this.dependencies.people, completed: new Map(), onReceipt: async () => {},
      });
      session.lastModelCallAt = this.now();
      await agent.warmCache!({ stableSystem: stableAgentPrompt({ voice: true,
        repository: repository && { name: this.dependencies.code.name, ...repository },
        boardName: this.dependencies.board.name, chatName: this.dependencies.chat?.name }),
      tools: toolbox.specs, usageContext: sessionId });
    };
    const loop = () => {
      void warm().catch(() => undefined).finally(() => {
        if (this.sessions.get(sessionId) !== session || session.ending) return;
        session.cacheTimer = setTimeout(loop, 60_000);
        session.cacheTimer.unref?.();
      });
    };
    loop();
  }

  async startSession(sessionId: string, meeting: MeetingPort, meetingUrl?: string): Promise<void> {
    this.validateSessionId(sessionId);
    if (this.sessions.has(sessionId) || this.startingSessions.has(sessionId)) throw new Error('session already exists');
    this.startingSessions.add(sessionId);
    try {
      await meeting.join(meetingUrl);
      this.addSession(sessionId, meeting);
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }
  restoreSession(sessionId: string, meeting: MeetingPort): void {
    if (this.sessions.has(sessionId) || this.startingSessions.has(sessionId)) throw new Error('session already exists');
    this.addSession(sessionId, meeting);
  }
  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }
  async endSession(sessionId: string, leaveProvider = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.endingPromise) return session.endingPromise;
    session.ending = true;
    if (session.cacheTimer) clearTimeout(session.cacheTimer);
    for (const question of session.questions) question.abort.abort();
    session.floor?.close();
    const ending = (async () => {
      await session.processing;
      if (this.sessions.get(sessionId) !== session) return;
      // Keep the session and provider handle until leave is confirmed. If the
      // provider is temporarily unavailable, a later leave command can retry.
      if (leaveProvider) await session.meeting.leave();
      if (this.sessions.get(sessionId) !== session) return;
      this.sessions.delete(sessionId);
      this.dependencies.brain.endUsageSession?.(sessionId);
      session.history.length = 0;
      session.pendingFollowUp = undefined;
      session.activeRequest = undefined;
      session.eventIds.clear();
      for (const key of this.completed.keys()) {
        if (key.startsWith(`${sessionId}:`)) this.completed.delete(key);
      }
    })();
    session.endingPromise = ending;
    try { await ending; }
    catch (error) {
      session.endingPromise = undefined;
      throw error;
    }
  }
  sessionCount(): number { return this.sessions.size; }

  private async speakOrChat(sessionId: string, meeting: MeetingPort, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.clearProgressTimer(session);
      if (session.progressSpeech) await session.progressSpeech;
    }
    await this.deliverSpeech(sessionId, meeting, message);
    if (session) {
      session.history.push({ role: 'assistant', text: `Nogita: ${message}` });
      if (session.history.length > 24) session.history.shift();
      const active = session.activeRequest;
      if (active && message.trim().endsWith('?') && !isExplicitCreateRequest(active.request) &&
          !isExplicitPRRequest(active.request)) {
        session.pendingFollowUp = { ...active, question: message, expiresAt: this.now() + 60_000,
          afterSequence: session.lastArrivalSequence, kind: 'question' };
      }
    }
  }

  private async deliverSpeech(sessionId: string, meeting: MeetingPort, message: string, options?: SpeakOptions): Promise<void> {
    const active = this.sessions.get(sessionId)?.activeRequest;
    if (active && !active.firstSpeechRecorded) {
      active.firstSpeechRecorded = true;
      this.dependencies.usage?.recordResponseStage?.(sessionId, 'turn_to_first_speech_attempt', performance.now() - active.startedAt);
    }
    try {
      await (options ? meeting.speak(message, options) : meeting.speak(message));
      this.dependencies.usage?.recordTts(sessionId, true);
    } catch (error) {
      this.dependencies.usage?.recordTts(sessionId, false);
      if (!(error instanceof SpeechFallbackSentError)) await meeting.sendStatus(message);
    }
  }

  private async modelCall<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try { return await run(); }
    finally { this.dependencies.usage?.recordResponseStage?.(sessionId, 'model_roundtrip', performance.now() - startedAt); }
  }

  private clearProgressTimer(session: Session): void {
    if (session.progressTimer === undefined) return;
    this.cancel(session.progressTimer);
    session.progressTimer = undefined;
  }

  private beginProgressAcknowledgment(sessionId: string, session: Session, delayMs = this.progressDelayMs,
    phrases: readonly string[] = progressPhrases, options?: SpeakOptions): void {
    session.progressSpeech = undefined;
    session.progressTimer = this.schedule(() => {
      session.progressTimer = undefined;
      if (this.sessions.get(sessionId) !== session || session.ending) return;
      const choices = phrases.filter(phrase => phrase !== session.lastProgressPhrase);
      const selected = Math.min(choices.length - 1, Math.max(0, Math.floor(this.random() * choices.length)));
      const phrase = choices[selected]!;
      session.lastProgressPhrase = phrase;
      session.progressSpeech = this.deliverSpeech(sessionId, session.meeting, phrase, options).catch(() => undefined);
      return session.progressSpeech;
    }, delayMs);
  }

  /** Someone's microphone carries their own voice right now (audio level, faster than recognition). */
  noteVoice(sessionId: string, speakerKey: string): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.ending) session.floor?.noteTalking(speakerKey);
  }

  /** Interim human speech cancels unsent filler for the prior turn, and Nogita's next words wait for an opening. */
  cancelProgressForSpeechActivity(sessionId: string, speakerKey?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ending) return;
    if (speakerKey) session.floor?.noteTalking(speakerKey);
    if (session.progressTimer !== undefined) this.clearProgressTimer(session);
  }

  /** Repository map for the agent prompt, refreshed in the background so a turn never waits long for it. */
  private async repositoryOverview(): Promise<{ paths: string[]; readme?: string; revision?: string } | undefined> {
    const code = this.dependencies.code;
    if (!code.overview) return undefined;
    const cached = this.repositoryMap;
    const fresh = cached?.value && this.now() - cached.at < 5 * 60_000;
    if (!fresh && !cached?.pending) {
      const entry = cached ?? { at: 0 };
      entry.pending = code.overview().then(value => { entry.value = value; entry.at = this.now(); })
        .catch(() => undefined).finally(() => { entry.pending = undefined; });
      this.repositoryMap = entry;
    }
    const entry = this.repositoryMap!;
    if (!entry.value && entry.pending) {
      await Promise.race([entry.pending, new Promise(resolve => setTimeout(resolve, 2_500))]);
    }
    return entry.value;
  }

  private async prefetchEvidence(request: string): Promise<Evidence[]> {
    if (!isRepositoryQuestion(request) || isExplicitCreateRequest(request)) return [];
    try {
      const found = await Promise.race([this.dependencies.code.findEvidence(request),
        new Promise<Evidence[]>(resolve => setTimeout(() => resolve([]), 1_500))]);
      return found.slice(0, 3);
    } catch { return []; }
  }

  /**
   * Background check, at most every `assessmentIntervalMs` and after a few new utterances, for something critical
   * the room is missing. It never speaks: it only raises a hand (or posts the configured chat fallback).
   */
  private maybeAssessContribution(sessionId: string, s: Session): void {
    s.utterancesSinceAssessment++;
    const canSignal = s.meeting.capabilities.has('raise_hand') || this.handRaiseFallback === 'chat';
    if (!canSignal || !s.meeting.capabilities.has('listen') || s.raised || s.assessing || this.now() < s.mutedUntil ||
        s.utterancesSinceAssessment < 4 || this.now() - s.lastAssessmentAt < this.assessmentIntervalMs) return;
    s.assessing = true;
    s.lastAssessmentAt = this.now();
    s.utterancesSinceAssessment = 0;
    const context = s.history.map(turn => turn.text);
    void this.dependencies.brain.assessContribution!(context, sessionId).then(async assessment => {
      if (!assessment.raise || !assessment.reason || this.sessions.get(sessionId) !== s || s.ending || s.raised) return;
      s.raised = true;
      s.raisedReason = assessment.reason;
      s.mutedUntil = this.now() + 5 * 60_000;
      const native = await s.meeting.raiseHand().catch(() => false);
      if (!native && this.handRaiseFallback === 'chat') {
        await s.meeting.sendStatus(`\u270B Nogita has something to add${assessment.topic ? ` about ${assessment.topic}` : ''}. ` +
          'Say "Nogita, go ahead" to hear it.').catch(() => undefined);
      }
    }).catch(() => undefined).finally(() => { s.assessing = false; });
  }

  /** Speech for a streamed chunk: no chat mirror (the whole answer goes to chat once) and no chat fallback.
   *  Returns false when a participant interrupted, so the rest of the answer is not spoken over them. */
  private async deliverStreamedSpeech(sessionId: string, meeting: MeetingPort, text: string): Promise<boolean> {
    const active = this.sessions.get(sessionId)?.activeRequest;
    if (active && !active.firstSpeechRecorded) {
      active.firstSpeechRecorded = true;
      this.dependencies.usage?.recordResponseStage?.(sessionId, 'turn_to_first_speech_attempt', performance.now() - active.startedAt);
    }
    try {
      await meeting.speak(text, { chatMirror: false });
      this.dependencies.usage?.recordTts(sessionId, true);
      return true;
    } catch (error) {
      this.dependencies.usage?.recordTts(sessionId, false);
      return !(error instanceof Error && /interrupt/i.test(error.message));
    }
  }

  /** Speech for the floor: no chat mirror (the whole answer goes to chat once) and no chat fallback. */
  private async floorSpeak(sessionId: string, s: Session, text: string, owner: number): Promise<SpeakResult> {
    this.onSpeech?.(sessionId, { questionId: owner, phase: 'start' });
    let result: SpeakResult;
    try {
      await s.meeting.speak(text, { chatMirror: false });
      this.dependencies.usage?.recordTts(sessionId, true);
      result = 'spoken';
    } catch (error) {
      this.dependencies.usage?.recordTts(sessionId, false);
      result = error instanceof SpeechInterruptedError ? { outcome: 'interrupted', heardMs: error.playedMs }
        : error instanceof Error && /interrupt/i.test(error.message) ? 'interrupted' : 'failed';
    }
    const outcome = typeof result === 'string' ? result : result.outcome;
    this.onSpeech?.(sessionId, { questionId: owner, phase: 'end', outcome,
      ...(typeof result !== 'string' && result.heardMs !== undefined ? { heardMs: Math.round(result.heardMs) } : {}) });
    return result;
  }

  private setStatus(sessionId: string, s: Session, id: number, status: QuestionStatus, detail?: string): void {
    const question = s.questions.find(q => q.id === id);
    if (!question || (question.status === status && !detail)) return;
    this.reportQuestion(sessionId, question, status, detail);
  }
  private reportQuestion(sessionId: string, q: Question, status: QuestionStatus, detail?: string): void {
    q.status = status;
    this.onQuestion?.(sessionId, { id: q.id, status, speaker: q.speaker, request: q.request,
      ...(q.topic ? { topic: q.topic } : {}), ...(detail ? { detail } : {}) });
  }
  private static isOpen(q: Question): boolean {
    return q.status === 'working' || q.status === 'answering' || q.status === 'interrupted';
  }

  /** A few words for "About ___, ..." when answers to different questions follow each other. */
  private ensureTopic(sessionId: string, q: Question): void {
    if (q.topic || q.topicPending || !this.dependencies.agent) return;
    q.topicPending = true;
    void this.dependencies.agent.streamChat({
      stableSystem: 'Name the topic of the question in two to five words, the way it would follow "About" in a reply ' +
        '(for example: "the login bug", "Yossi\'s pull request", "the release date"). Reply with the words only.',
      turnSystem: '', messages: [{ role: 'user', content: q.request }], tools: [], maxTokens: 20,
      usageContext: sessionId, timeoutMs: 5_000,
    }, () => undefined).then(response => {
      const text = response.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join(' ')
        .replace(/^about\s+/i, '').replace(/[."]+$/g, '').replace(/^"/, '').trim();
      if (text && text.split(/\s+/).length <= 7) q.topic = text;
    }).catch(() => undefined).finally(() => { q.topicPending = false; });
  }
  private topicLabel(q: Question): string | undefined {
    if (!q.needsLabel || q.labelled || q.agentNamesTopic || !q.topic) return undefined;
    q.labelled = true;
    return `About ${q.topic}, `;
  }

  private clearQuestionProgress(q: Question): void {
    if (q.progressTimer === undefined) return;
    this.cancel(q.progressTimer);
    q.progressTimer = undefined;
  }

  /** A late "one sec" for a question that has said nothing yet; a different one when another question is open. */
  private beginQuestionProgress(sessionId: string, s: Session, q: Question): void {
    q.progressTimer = this.schedule(() => {
      q.progressTimer = undefined;
      if (q.queuedSpeech || q.abort.signal.aborted || !s.floor || this.sessions.get(sessionId) !== s || s.ending) return;
      const overlap = s.questions.some(other => other !== q && NogitaEngine.isOpen(other));
      const phrases = (overlap ? OVERLAP_PROGRESS : agentProgressPhrases).filter(phrase => phrase !== s.lastProgressPhrase);
      const phrase = phrases[Math.min(phrases.length - 1, Math.floor(this.random() * phrases.length))]!;
      s.lastProgressPhrase = phrase;
      void s.floor.say(q.id, phrase, { leadIn: true });
    }, this.agentProgressDelayMs);
  }

  private newQuestion(s: Session, utterance: Utterance, request: string, status: QuestionStatus, startedAt: number): Question {
    let commit!: () => void;
    const gate = new Promise<void>(resolve => { commit = resolve; });
    return { id: s.nextQuestionId++, actorId: utterance.actor.id, speaker: utterance.actor.displayName, request,
      key: questionKey(request), askedAt: this.now(), startedAt, status, needsLabel: false, labelled: false,
      agentNamesTopic: false, abort: new AbortController(), gate, commit, firstSpeechRecorded: false, queuedSpeech: false, interruptions: 0 };
  }

  /** The question joins the open ones: overlapping questions name their topic when answered. */
  private openQuestion(sessionId: string, s: Session, q: Question): void {
    const others = s.questions.filter(other => NogitaEngine.isOpen(other));
    s.questions = s.questions.filter(other => NogitaEngine.isOpen(other) || this.now() - other.askedAt < 120_000).slice(-20);
    s.questions.push(q);
    if (others.length) {
      for (const other of others) {
        if (!other.agentNamesTopic) { other.needsLabel = true; this.ensureTopic(sessionId, other); }
      }
      q.needsLabel = true;
      this.ensureTopic(sessionId, q);
    }
    this.reportQuestion(sessionId, q, 'working');
    this.beginQuestionProgress(sessionId, s, q);
    q.commit();
  }

  /**
   * "Stop" and "never mind" in a voice meeting, from anyone who addressed Nogita or from the person whose question
   * is open. Returns undefined when the words are not such a command.
   */
  private handleVoiceCommand(sessionId: string, s: Session, actorId: string, text: string, addressed: boolean): ProcessResult | undefined {
    const floor = s.floor;
    if (!floor) return undefined;
    const open = s.questions.filter(q => NogitaEngine.isOpen(q));
    if (isCancelCommand(text)) {
      const target = open.filter(q => q.actorId === actorId).at(-1) ?? (addressed ? open.at(-1) : undefined);
      if (!target) return undefined;
      // "Dropping that" only makes sense while she is still looking; once she was answering, a plain "Okay" does.
      const wasAnswering = target.status === 'answering' || target.status === 'interrupted';
      target.abort.abort();
      this.clearQuestionProgress(target);
      floor.drop(target.id);
      this.reportQuestion(sessionId, target, 'cancelled', 'asked to drop it');
      this.sayAside(s, wasAnswering ? 'Okay.' : 'Okay, dropping that.');
      void s.meeting.sendStatus(`Dropped the question${target.topic ? ` about ${target.topic}` : `: "${target.request}"`}.`).catch(() => undefined);
      return 'answered';
    }
    if (isStopCommand(text)) {
      const speaking = [floor.interrupted, floor.current].filter((id): id is number => id !== undefined);
      const targets = speaking.length ? speaking : addressed ? floor.owners() : [];
      if (!targets.length) return addressed ? 'ignored' : undefined;
      for (const id of new Set(targets)) {
        floor.drop(id);
        const question = s.questions.find(q => q.id === id);
        if (question) this.reportQuestion(sessionId, question, 'stopped', 'asked to stop; the answer is in chat');
      }
      return 'answered';
    }
    return undefined;
  }

  /**
   * Starts answering before the speaker's turn is confirmed over (Deepgram's early end-of-turn). Nothing is said or
   * changed until `onUtterance` confirms the same words; `cancel()` rolls it back when the speaker kept talking.
   */
  speculate(sessionId: string, utterance: Utterance): Speculation | undefined {
    const s = this.sessions.get(sessionId);
    const current = utterance.text.trim().slice(0, 4000);
    if (!s || s.ending || !s.floor || !this.dependencies.agent || !utterance.actor.verified || !directlyAddressesNogita(current)) return undefined;
    const request = removeAddress(current);
    // "Stop. Just tell me..." is handled when the turn is confirmed: the stop first, then the rest as its own question.
    if (!request || isCancelCommand(request) || isStopCommand(request) || splitLeadingStop(request) || isExplicitLeaveRequest(request)) return undefined;
    const key = questionKey(request);
    if (s.questions.some(q => NogitaEngine.isOpen(q) && q.actorId === utterance.actor.id && q.key === key)) return undefined;
    const q = this.newQuestion(s, utterance, request, 'speculative', performance.now());
    this.onQuestion?.(sessionId, { id: q.id, status: 'speculative', speaker: q.speaker, request });
    q.run = this.runAgentTurn(sessionId, s, utterance, request, undefined, q, s.history.map(turn => turn.text))
      .catch(() => undefined);
    return { sessionId, question: q, cancel: () => {
      if (q.status !== 'speculative') return;
      q.abort.abort();
      this.reportQuestion(sessionId, q, 'rolled_back', 'the speaker kept talking');
    } };
  }

  /**
   * One direct request answered by the tool-using agent. Returns undefined when the agent failed before
   * saying or changing anything, so the caller can fall back to the planner. In a voice meeting `q` is the
   * question being answered; its speech goes through the session's speech floor.
   */
  private async runAgentTurn(sessionId: string, s: Session, utterance: Utterance, request: string,
    pending: Session['pendingFollowUp'], q?: Question, history?: string[]): Promise<ProcessResult | undefined> {
    const leave = { asked: false };
    try { return await this.agentTurn(sessionId, s, utterance, request, pending, q, history, leave); }
    finally {
      // After her goodbye was spoken; a rolled-back early start never leaves.
      if (leave.asked && !q?.abort.signal.aborted && !s.ending) this.onLeaveRequested?.(sessionId);
    }
  }

  private async agentTurn(sessionId: string, s: Session, utterance: Utterance, request: string,
    pending: Session['pendingFollowUp'], q: Question | undefined, history: string[] | undefined,
    leave: { asked: boolean }): Promise<ProcessResult | undefined> {
    const agent = this.dependencies.agent!;
    const raisedReason = s.raisedReason;
    // A speculative start reads the reason but leaves it for the confirmed question.
    if (q?.status !== 'speculative') s.raisedReason = undefined;
    const voice = s.meeting.capabilities.has('speak');
    const streaming = voice && s.meeting.capabilities.has('streaming_speech');
    const floor = q ? s.floor : undefined;
    const speaker = utterance.actor.displayName;
    const authorized = this.dependencies.policy.mayReadCode(utterance.actor);
    const writeScope = pending ? `${pending.request}\n${request}` : request;
    let userText = pending?.question ? `(Your previous message to ${speaker} was: "${pending.question}")\n${request}` : request;
    // A quick in-memory search runs alongside the repository map, so most code questions need one lookup round fewer.
    const [repository, prefetched] = authorized
      ? await Promise.all([this.repositoryOverview(), this.prefetchEvidence(request)])
      : [undefined, []];
    if (prefetched.length) {
      userText += `\n\nQuick search results for this request (untrusted data; read files for details):\n${prefetched
        .map(item => `${item.path} (${item.url})\n${item.excerpt.slice(0, 1200)}`).join('\n---\n')}`;
    }
    const { toolbox, report } = buildToolbox({
      actor: utterance.actor, request: writeScope, sessionId, eventId: utterance.eventId,
      policy: this.dependencies.policy, code: this.dependencies.code, board: this.dependencies.board,
      chat: this.dependencies.chat, people: this.dependencies.people, completed: this.completed,
      onReceipt: receipt => s.meeting.sendCompletion(receipt),
      recordAction: action => this.dependencies.usage?.recordExternalAction(sessionId, action),
      ...(this.missions && authorized ? { missions: this.missionPort(sessionId, utterance.actor) } : {}),
      ...(this.onLeaveRequested && s.meeting.capabilities.has('speak') ? { leave: () => { leave.asked = true; } } : {}),
      ...(s.floor && this.onScreen ? { show: (card: ScreenCard | undefined) => this.onScreen!(sessionId, card),
        ...(this.screenAudience ? { screenAudience: () => this.screenAudience!(sessionId) } : {}) } : {}),
    });
    // A text thread carries its own history (including messages that never addressed Nogita).
    let transcript = history ?? s.history.slice(0, -1).map(turn => turn.text);
    if (s.meeting.recentContext) {
      const thread = await Promise.race([s.meeting.recentContext().catch(() => [] as string[]),
        new Promise<string[]>(resolve => setTimeout(() => resolve([]), 2_000))]);
      if (thread.length) transcript = thread.slice(0, -1);
    }
    const otherQuestions = q ? s.questions.filter(other => other !== q && NogitaEngine.isOpen(other)) : [];
    if (q && otherQuestions.length) q.agentNamesTopic = true;
    let spoke = false;
    let speech = Promise.resolve();
    const said: Array<{ step: number; leadIn: boolean; outcome: Promise<string> }> = [];
    const leadInSteps = new Set<number>();
    let spokenWords = 0;
    const maxWords = wantsDetail(request) ? DETAIL_SPOKEN_WORDS : MAX_SPOKEN_WORDS;
    let truncatedSpeech = false;
    let stillWorking: unknown;
    let stillWorkingUsed = false;
    let interrupted = false;
    const queueSpeech = (text: string, step: number, leadIn = false) => {
      if (floor && q) {
        q.queuedSpeech = true;
        said.push({ step, leadIn, outcome: q.gate.then(() => {
          if (q.abort.signal.aborted) return 'dropped';
          if (!q.firstSpeechRecorded) {
            q.firstSpeechRecorded = true;
            this.dependencies.usage?.recordResponseStage?.(sessionId, 'turn_to_first_speech_attempt', performance.now() - q.startedAt);
          }
          const isLeadIn = leadIn || leadInSteps.has(step);
          if (!isLeadIn) this.setStatus(sessionId, s, q.id, 'answering');
          return floor.say(q.id, text, { leadIn: isLeadIn, prefix: step > 0 ? () => this.topicLabel(q) : undefined });
        }) });
        return;
      }
      speech = speech.then(async () => {
        if (interrupted) return;
        if (s.progressSpeech) await s.progressSpeech;
        if (!await this.deliverStreamedSpeech(sessionId, s.meeting, text)) interrupted = true;
      });
    };
    const onSpeech = (raw: string, step: number) => {
      if (!spoke) {
        spoke = true;
        this.clearProgressTimer(s);
        if (q) this.clearQuestionProgress(q);
      }
      if (stillWorking !== undefined) { this.cancel(stillWorking); stillWorking = undefined; }
      const text = toSpoken(raw);
      if (!text || truncatedSpeech) return;
      // Spoken answers stay short; anything longer is in the chat copy of the answer.
      if (!streaming) {
        // Whole pieces (a lead-in, then the answer): keep at least the first sentence of each.
        const short = firstWords(text, Math.max(1, maxWords - spokenWords));
        spokenWords += short.split(/\s+/).length;
        queueSpeech(short, step);
        if (short !== text) { truncatedSpeech = true; queueSpeech(this.phrases.pick(REST_IN_CHAT), step); }
        return;
      }
      const words = text.split(/\s+/).length;
      if (spokenWords > 0 && spokenWords + words > maxWords) {
        truncatedSpeech = true;
        queueSpeech(this.phrases.pick(REST_IN_CHAT), step);
        return;
      }
      spokenWords += words;
      queueSpeech(text, step);
      // After a spoken lead-in, a long silence while tools run gets one short "still on it".
      if (!stillWorkingUsed) {
        stillWorking = this.schedule(() => {
          stillWorking = undefined;
          if (stillWorkingUsed || truncatedSpeech || this.sessions.get(sessionId) !== s || q?.abort.signal.aborted) return;
          stillWorkingUsed = true;
          queueSpeech(this.phrases.pick(STILL_WORKING), step, true);
        }, 6_000);
      }
    };
    const onToolUse = (names: string[], step: number) => {
      leadInSteps.add(step);
      this.onActivity?.(sessionId, { kind: 'tool', ...(q ? { questionId: q.id } : {}), tools: names });
      if (!floor || !q) return;
      // What she said so far was a lead-in: while the lookup runs, others may speak.
      floor.markLeadIns(q.id);
      floor.release(q.id);
      if (q.status === 'answering') this.setStatus(sessionId, s, q.id, 'working');
    };
    const settleSpeech = async () => {
      const outcomes = await Promise.all(said.map(async item => ({ ...item, result: await item.outcome })));
      if (floor && q) floor.release(q.id);
      return outcomes;
    };
    let result;
    s.lastModelCallAt = this.now();
    try {
      result = await this.modelCall(sessionId, () => runAgent(agent, {
        stableSystem: stableAgentPrompt({ voice,
          repository: repository && { name: this.dependencies.code.name, ...repository },
          boardName: authorized ? this.dependencies.board.name : undefined,
          chatName: authorized ? this.dependencies.chat?.name : undefined }),
        turnSystem: turnAgentPrompt({ speaker, authorized, nowIso: new Date(this.now()).toISOString(), followUp: pending !== undefined,
          raisedHandReason: raisedReason, otherQuestions: otherQuestions.map(other => `${other.speaker}: "${other.request}"`) }),
        messages: [{ role: 'user', content: agentUserMessage(transcript, speaker, userText) }],
        toolbox, stream: streaming, onSpeech: voice ? onSpeech : undefined, usageContext: sessionId,
        deadlineMs: voice ? 45_000 : 90_000, maxTokens: voice ? 600 : 1_500, maxSteps: voice ? 5 : 8,
        onToolUse, signal: q?.abort.signal, beforeWrite: q ? () => q.gate : undefined,
      }));
    } catch {
      if (stillWorking !== undefined) this.cancel(stillWorking);
      if (q?.abort.signal.aborted) { await settleSpeech(); return 'ignored'; }
      await speech;
      if (q) await Promise.race([q.gate, new Promise(resolve => q.abort.signal.addEventListener('abort', resolve, { once: true }))]);
      if (q?.abort.signal.aborted) { await settleSpeech(); return 'ignored'; }
      await settleSpeech();
      if (!spoke && !report.wroteSomething) {
        if (q) this.reportQuestion(sessionId, q, 'failed', 'model error; the planner answers instead');
        return undefined;
      }
      this.clearProgressTimer(s);
      if (floor && q) {
        await floor.say(q.id, 'Sorry, something broke on my end and I couldn’t finish that.');
        this.reportQuestion(sessionId, q, 'failed', 'model error after speaking');
        return report.wroteSomething ? 'completed' : 'answered';
      }
      await this.speakOrChat(sessionId, s.meeting, 'Sorry, something broke on my end and I couldn’t finish that.');
      return report.wroteSomething ? 'completed' : 'answered';
    }
    if (stillWorking !== undefined) { this.cancel(stillWorking); stillWorking = undefined; }
    stillWorkingUsed = true;
    // A speculative answer waits here until the turn is confirmed (or rolled back).
    if (q) await Promise.race([q.gate, new Promise(resolve => q.abort.signal.addEventListener('abort', resolve, { once: true }))]);
    if (q?.abort.signal.aborted) { await settleSpeech(); return 'ignored'; }
    let answer = result.answer;
    if (!answer && result.stoppedEarly) answer = 'This is taking me too long. Can you narrow it down a bit?';
    if (floor && q && answer && !result.answer) queueSpeech(answer, result.steps);
    await speech;
    const outcomes = await settleSpeech();
    this.clearProgressTimer(s);
    if (q) this.clearQuestionProgress(q);
    if (s.progressSpeech) await s.progressSpeech;
    // Superseded or cancelled while the answer was being spoken: the old answer goes nowhere, not even chat.
    if (q?.abort.signal.aborted) return 'ignored';
    if (q && NogitaEngine.isOpen(q)) {
      const lost = outcomes.filter(item => !item.leadIn && !leadInSteps.has(item.step) && item.result !== 'spoken');
      this.reportQuestion(sessionId, q, lost.length ? 'chat_only' : 'answered',
        lost.length ? `${lost.length} spoken part(s) not delivered (${[...new Set(lost.map(item => item.result))].join(', ')}); the answer is in chat`
          : answer ? undefined : 'no reply');
    }
    if (!answer) return spoke || report.wroteSomething ? (report.wroteSomething ? 'completed' : 'answered') : 'ignored';
    if (voice) {
      // The final answer was spoken while it streamed (unless the turn was cut short); chat gets it once.
      if (!result.answer && !floor) await this.deliverStreamedSpeech(sessionId, s.meeting, answer);
      const chatText = q && q.needsLabel && !q.agentNamesTopic && q.topic ? `About ${q.topic}: ${answer}` : answer;
      try { await s.meeting.sendStatus(chatText); } catch { /* Speech already delivered; chat is best effort. */ }
      s.history.push({ role: 'assistant', text: `Nogita: ${answer}` });
      if (s.history.length > 24) s.history.shift();
    } else {
      await this.speakOrChat(sessionId, s.meeting, answer);
    }
    // A question invites a reply without the name, even when instructions follow it ("What should the task be
    // about? Give me a title... Also tell me who owns it.") — the voice lab caught that case.
    if (asksQuestion(answer)) {
      s.pendingFollowUp = { actorId: utterance.actor.id, request: writeScope, question: answer,
        expiresAt: this.now() + 60_000, afterSequence: s.lastArrivalSequence, kind: 'question' };
    } else if (s.floor) {
      // A live conversation: the person she just answered goes on without her name ("and the other one?").
      // The agent stays silent when it was not for her; a write still needs the new words to ask for it.
      s.pendingFollowUp = { actorId: utterance.actor.id, request: '', question: answer,
        expiresAt: this.now() + 30_000, afterSequence: s.lastArrivalSequence, kind: 'conversation' };
    }
    const codeTools = result.toolCalls.some(name => ['search_code', 'read_file', 'recent_commits'].includes(name));
    const reference = report.codeReferences[0];
    if (voice && codeTools && reference && !report.receipts.length) {
      await s.meeting.sendCompletion({ provider: this.dependencies.code.name, kind: 'code_lookup',
        url: reference.url, label: 'Code reference' }).catch(() => undefined);
      return 'completed';
    }
    return report.wroteSomething ? 'completed' : 'answered';
  }

  /**
   * A short line for a meeting or thread that is still open (a mission's progress): spoken when the room has an
   * opening (voice), and in chat. Returns false when the conversation is gone.
   */
  async announce(sessionId: string, text: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ending) return false;
    await s.meeting.sendStatus(text).catch(() => undefined);
    // Spoken after the answers people are waiting for, never ahead of them.
    const open = s.questions.filter(q => NogitaEngine.isOpen(q) && q.run).map(q => q.run!);
    if (s.floor) void Promise.allSettled(open).then(() => { if (this.sessions.get(sessionId) === s && !s.ending) this.sayAside(s, toSpoken(text)); });
    return true;
  }

  /** One line that belongs to no question (an acknowledgement, a mission update): it does not keep the floor after it. */
  private sayAside(s: Session, text: string): void {
    void s.floor?.say(0, text).finally(() => s.floor?.release(0));
  }

  /** Missions as one conversation turn may use them, bound to the person speaking. */
  private missionPort(sessionId: string, actor: Utterance['actor']): MissionPort {
    const runner = this.missions!;
    const mine = () => runner.list({ ownerId: actor.id });
    return {
      start: (goal, doneWhen) => runner.start({ goal, ...(doneWhen ? { doneWhen } : {}), owner: { id: actor.id, displayName: actor.displayName }, sessionId }),
      list: () => runner.list().filter(m => m.owner.id === actor.id || m.sessionId === sessionId)
        .filter(m => OPEN_MISSION.has(m.status) || this.now() - m.updatedAt < 3 * 60 * 60_000).slice(0, 6)
        .map(m => ({ id: m.id, goal: m.goal, status: m.status, owner: m.owner.displayName, ...(m.activity ? { activity: m.activity } : {}),
          ...(m.pending ? { pending: m.pending.summary } : {}),
          ...(m.steps.filter(step => step.kind === 'finding').at(-1) ? { lastFinding: m.steps.filter(step => step.kind === 'finding').at(-1)!.text } : {}),
          ...(m.result ? { result: m.result.summary } : m.blockedReason ? { result: `blocked: ${m.blockedReason}` } : {}) })),
      decide: async (decision, id, note) => {
        const fits = { approve: ['awaiting_approval'], decline: ['awaiting_approval'], resume: ['blocked', 'failed'],
          cancel: ['investigating', 'executing', 'awaiting_approval', 'blocked'] }[decision];
        let target = id;
        if (!target) {
          const candidates = mine().filter(m => fits.includes(m.status));
          if (candidates.length !== 1) {
            return { ok: false, message: candidates.length ? `Which one: ${candidates.map(m => m.id).join(', ')}?` : 'You have no mission waiting for that.' };
          }
          target = candidates[0]!.id;
        }
        if (decision === 'approve') return runner.approve(target, actor.id);
        if (decision === 'decline') return runner.reject(target, actor.id, note ? `The owner declined: ${note}` : undefined);
        if (decision === 'resume') return runner.resume(target, actor.id, note);
        return runner.cancel(target, actor.id);
      },
    };
  }

  /** Everyone heard counts (verified or not): it decides one-to-one versus group, and closes a follow-up window. */
  private noteSpeaker(s: Session, utterance: Utterance): void {
    const id = utterance.actor.id;
    (s.heard ??= new Map()).set(id, this.now());
    const first = utterance.actor.displayName.trim().split(/\s+/)[0] ?? '';
    if (first.length > 1 && utterance.actor.displayName !== 'Meeting participant' && !/^nogita$/i.test(first)) {
      (s.names ??= new Map()).set(id, first);
    }
    const pending = s.pendingFollowUp;
    if (pending?.kind === 'conversation' && pending.actorId !== id && !isBackchannel(utterance.text)) pending.intervened = true;
  }
  private otherNames(s: Session, actorId: string): string[] {
    return [...(s.names ?? new Map<string, string>())].filter(([id]) => id !== actorId).map(([, name]) => name);
  }
  /**
   * In a group, the 30-second window after an answer never outranks who is being talked to: it closes once someone
   * else spoke, and a "yeah" or words addressed to another person by name are not a follow-up.
   */
  private followUpRuledOut(s: Session, pending: NonNullable<Session['pendingFollowUp']>, text: string, actorId: string): boolean {
    if (addressesSomeoneElse(text, this.otherNames(s, actorId))) return true;
    return pending.kind === 'conversation' && (pending.intervened === true || isBackchannel(text));
  }

  /**
   * `speakerKey` names whose microphone it was (their turn is over, so the floor stops waiting for them);
   * `speculation` is the early start for these words, adopted when they match.
   */
  async onUtterance(sessionId: string, utterance: Utterance,
    context: { speakerKey?: string; speculation?: Speculation } = {}): Promise<ProcessResult> {
    const processingStartedAt = performance.now();
    let adopted = false;
    let released = false;
    let historyEntry: ConversationTurn | undefined;
    const s = this.sessions.get(sessionId);
    if (!s || s.ending) throw new Error('unknown session');
    this.noteSpeaker(s, utterance);
    if (!utterance.actor.verified || !utterance.eventId || !utterance.text.trim()) return 'ignored';
    const arrivalSequence = ++s.lastArrivalSequence;
    const previous = s.processing;
    let release!: () => void;
    s.processing = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
    if (this.sessions.get(sessionId) !== s) throw new Error('unknown session');
    if (s.eventIds.has(utterance.eventId)) return 'ignored';
    s.eventIds.add(utterance.eventId);
    const historyBefore = s.history.slice();
    const pendingBefore = s.pendingFollowUp;
    const raisedBefore = s.raised;
    const mutedUntilBefore = s.mutedUntil;
    try {
    // Prevent unbounded in-memory event metadata or transcript retention.
    if (s.eventIds.size > 2000) s.eventIds.delete(s.eventIds.values().next().value!);
    let current = utterance.text.trim().slice(0, 4000);
    historyEntry = { role: 'user', text: `${utterance.actor.displayName}: ${current}` };
    s.history.push(historyEntry);
    if (s.history.length > 24) s.history.shift();

    if (isCourtesyClose(current)) {
      s.pendingFollowUp = undefined;
      s.calledBy = undefined;
      return 'ignored';
    }

    const called = s.calledBy?.actorId === utterance.actor.id && this.now() <= s.calledBy.until;
    s.calledBy = undefined;
    // The asker went on after a pause ("Nogita, can you check... um, which file starts the server?"): what she heard
    // first was only the start of the question, so that answer is dropped and the whole question answered.
    let wholeRequest: string | undefined;
    if (s.floor && this.dependencies.agent && !directlyAddressesNogita(current) && !isCancelCommand(current) && !isStopCommand(current) &&
        !isBackchannel(current) && !addressesSomeoneElse(current, this.otherNames(s, utterance.actor.id))) {
      // A correction ("no, I meant the mobile app") replaces the speaker's open question even well after it was asked,
      // and stops what she is saying about the old one.
      const correction = looksLikeCorrection(current);
      const started = s.questions.filter(q => NogitaEngine.isOpen(q) && q.actorId === utterance.actor.id &&
        this.now() - q.askedAt < (correction ? 60_000 : 8_000)).at(-1);
      if (started) {
        started.abort.abort();
        this.clearQuestionProgress(started);
        s.floor.drop(started.id);
        this.reportQuestion(sessionId, started, 'superseded',
          correction ? 'corrected by the asker; answering the corrected question' : 'the speaker went on; answering the whole question');
        wholeRequest = correction ? `${started.request}\n(${utterance.actor.displayName} then corrected: "${current}")`
          : `${started.request} ${current}`;
      }
    }
    const directlyAddressed = directlyAddressesNogita(current) || called || wholeRequest !== undefined;
    const heard = s.heard ??= new Map();
    for (const [actorId, at] of heard) if (this.now() - at > 5 * 60_000) heard.delete(actorId);
    // Only one person and Nogita in the call: their questions are for her, name or not (the agent stays silent otherwise).
    const oneToOne = !directlyAddressed && Boolean(s.floor && this.dependencies.agent) && heard.size === 1 && looksLikeRequest(current);
    let pending = s.pendingFollowUp;
    if (oneToOne && !(pending?.actorId === utterance.actor.id && this.now() <= pending.expiresAt)) {
      pending = { actorId: utterance.actor.id, request: '', question: '', expiresAt: this.now() + 1, afterSequence: arrivalSequence - 1 };
    }
    const continuation = !directlyAddressed && pending !== undefined &&
      pending.actorId === utterance.actor.id && arrivalSequence > pending.afterSequence &&
      this.now() <= pending.expiresAt && !this.followUpRuledOut(s, pending, current, utterance.actor.id) &&
      // The agent can tell a real reply from unrelated talk (it answers with silence); the planner cannot.
      (this.dependencies.agent !== undefined || isAffirmativeFollowUp(current));
    if (s.floor) {
      const voiceText = directlyAddressed ? removeAddress(current) : current;
      const compoundStop = splitLeadingStop(voiceText);
      const command = this.handleVoiceCommand(sessionId, s, utterance.actor.id,
        compoundStop?.stop ?? voiceText, directlyAddressed);
      if (context.speakerKey) s.floor.noteTalking(context.speakerKey, true);
      if (command && compoundStop?.remainder) {
        current = compoundStop.remainder;
      } else
      if (command) {
        // "Stop. Just tell me the file name.": what the same person says next is still for her.
        if (command === 'answered') s.calledBy = { actorId: utterance.actor.id, until: this.now() + 6_000 };
        return command;
      }
      // The person she was answering cut her off and went on talking: they moved on, so she does not pick the
      // answer up again over them ("As I was saying..."); it is in the chat. A "yeah" or "okay" is not moving on.
      const cut = s.questions.find(other => other.id === s.floor!.interrupted);
      // Only when nobody else spoke since the cut: the asker answering someone else ("yes, you sound fine") has not
      // moved on from her answer, which resumes once the room is quiet.
      const othersSince = cut?.interruptedAt !== undefined && [...(s.heard ?? new Map<string, number>())]
        .some(([id, at]) => id !== utterance.actor.id && at >= cut.interruptedAt!);
      if (cut && cut.actorId === utterance.actor.id && !isBackchannel(current) && !othersSince) {
        s.floor.drop(cut.id);
        this.reportQuestion(sessionId, cut, 'chat_only', 'the asker went on talking; the rest is in chat');
      }
    }
    if (!directlyAddressed && !continuation) {
      // A "yeah" while listening keeps the conversation open; anything else from the same person moves on.
      if (pending?.actorId === utterance.actor.id && !isBackchannel(current)) s.pendingFollowUp = undefined;
      if (this.dependencies.agent && this.dependencies.brain.assessContribution) {
        this.maybeAssessContribution(sessionId, s);
        return 'ignored';
      }
      if (!s.raised && Date.now() > s.mutedUntil && s.history.length > 1 &&
          await this.dependencies.brain.suggestContribution(s.history.map(turn => turn.text))) {
        const supported = await s.meeting.raiseHand();
        if (supported) { s.raised = true; s.mutedUntil = Date.now() + 5 * 60_000; return 'raised_hand'; }
      }
      return 'ignored';
    }

    // Asking Nogita to speak permits speech only here; raising a hand does not.
    s.raised = false;
    s.pendingFollowUp = undefined;
    if (this.dependencies.agent && s.floor) {
      // Voice: every question runs on its own, so the next person need not wait for this answer.
      const agentRequest = wholeRequest ?? (directlyAddressed ? removeAddress(current) : current);
      if (!agentRequest.replace(/[^\p{L}\p{N}]/gu, '')) {
        // Only her name: the question is coming in the speaker's next words.
        s.calledBy = { actorId: utterance.actor.id, until: this.now() + 10_000 };
        return 'ignored';
      }
      const key = questionKey(agentRequest);
      const same = s.questions.find(q => NogitaEngine.isOpen(q) && q.actorId === utterance.actor.id && q.key === key);
      if (same) {
        this.onQuestion?.(sessionId, { id: same.id, status: same.status, speaker: same.speaker, request: same.request,
          detail: 'asked again; one lookup is already running' });
        if (!same.queuedSpeech) void s.floor.say(same.id, 'Still on it.', { leadIn: true });
        return 'ignored';
      }
      // The asker cut off their own answer with a new question: they moved on, so it is not resumed.
      const cut = s.questions.find(other => other.id === s.floor!.interrupted);
      if (cut && cut.actorId === utterance.actor.id) {
        s.floor.drop(cut.id);
        this.reportQuestion(sessionId, cut, 'chat_only', 'the asker moved on to a new question; the rest is in chat');
      }
      const early = context.speculation?.question as Question | undefined;
      let q: Question;
      if (early && context.speculation!.sessionId === sessionId && early.status === 'speculative' && !early.abort.signal.aborted &&
          early.actorId === utterance.actor.id && early.key === key && !continuation) {
        q = early;
        adopted = true;
        s.raisedReason = undefined;
        this.openQuestion(sessionId, s, q);
      } else {
        q = this.newQuestion(s, utterance, agentRequest, 'working', processingStartedAt);
        this.openQuestion(sessionId, s, q);
        q.run = this.runAgentTurn(sessionId, s, utterance, agentRequest, continuation ? pending : undefined, q);
      }
      released = true;
      release();
      let outcome: ProcessResult | undefined;
      try { outcome = await q.run!; }
      finally {
        // Every confirmed question ends in a final status, so the presence screen never stays on it.
        if (NogitaEngine.isOpen(q)) this.reportQuestion(sessionId, q, 'failed', 'ended without a final status');
      }
      if (outcome) return outcome;
    } else if (this.dependencies.agent) {
      // In a text thread the answer arrives in seconds; a "one second" message would only add noise.
      if (s.meeting.capabilities.has('speak')) {
        this.beginProgressAcknowledgment(sessionId, s, this.agentProgressDelayMs, agentProgressPhrases, { chatMirror: false });
      }
      const agentRequest = directlyAddressed ? removeAddress(current) : current;
      s.activeRequest = { actorId: utterance.actor.id, request: agentRequest, startedAt: processingStartedAt, firstSpeechRecorded: false };
      const outcome = await this.runAgentTurn(sessionId, s, utterance, agentRequest, continuation ? pending : undefined);
      if (outcome) return outcome;
      // The agent failed before saying or doing anything: answer through the planner instead.
      this.clearProgressTimer(s);
    }
    if (continuation) {
      try { await s.meeting.sendStatus('I heard your reply. I’m continuing that question.'); }
      catch { /* Chat is best effort; spoken answer still proceeds. */ }
    }
    this.beginProgressAcknowledgment(sessionId, s);
    const request = directlyAddressed ? removeAddress(current)
      : pending && /\b(?:repo|repository|github|code)\b/i.test(pending.question)
        ? `${pending.request} repository` : current;
    s.activeRequest = { actorId: utterance.actor.id, request, startedAt: processingStartedAt, firstSpeechRecorded: false };
    if (isRepositoryConnectionQuestion(request)) {
      if (!this.dependencies.policy.mayReadCode(utterance.actor)) {
        await this.speakOrChat(sessionId, s.meeting, 'Sorry, I can’t look at the project code for you.');
        return 'denied';
      }
      let evidence;
      try {
        evidence = await this.dependencies.code.findEvidence('README package.json');
      } catch {
        await this.speakOrChat(sessionId, s.meeting,
          'I couldn’t get into GitHub just now. Someone should check my connection.');
        return 'answered';
      }
      this.dependencies.usage?.recordExternalAction(sessionId, 'code_lookup');
      if (!evidence.length) {
        await this.speakOrChat(sessionId, s.meeting, 'I could not verify a live repository connection.');
        return 'answered';
      }
      await this.speakOrChat(sessionId, s.meeting,
        'Yep, I can read the GitHub repo.');
      await s.meeting.sendCompletion({
        provider: this.dependencies.code.name, kind: 'code_lookup', url: evidence[0]!.url,
        label: 'Code reference',
      });
      return 'completed';
    }
    let initialEvidence: Evidence[] = [];
    if (this.dependencies.code.name === 'github' && isRepositoryQuestion(request) &&
        !this.dependencies.policy.mayReadCode(utterance.actor)) {
      await this.speakOrChat(sessionId, s.meeting, 'Sorry, I can’t look at the project code for you.');
      return 'denied';
    }
    try {
      if (this.dependencies.code.name === 'github' && this.dependencies.policy.mayReadCode(utterance.actor) &&
          isRepositoryQuestion(request) && !isExplicitCreateRequest(request) && !isExplicitPRRequest(request)) {
        const overview = isRepositoryOverviewQuestion(request);
        const found = await this.dependencies.code.findEvidence(overview ? 'README package.json' : request);
        const overviewFiles = overview ? found.filter(item => /^(?:README\.md|package\.json)$/i.test(item.path))
          .sort((a, b) => Number(!/^README\.md$/i.test(a.path)) - Number(!/^README\.md$/i.test(b.path))) : [];
        initialEvidence = overviewFiles.length ? overviewFiles : found;
      }
    }
    catch (error) {
      if (error instanceof CodeLookupRateLimitError) {
        await this.speakOrChat(sessionId, s.meeting,
          'GitHub’s rate limit is blocking me right now. Give it a few minutes and ask again.');
        return 'answered';
      }
      /* Let ordinary questions proceed; an explicit code-inspection plan retries with expanded terms below. */
    }
    if (initialEvidence.length) this.dependencies.usage?.recordExternalAction(sessionId, 'code_lookup');
    const conversation = continuation ? s.history.slice() : s.history.slice(0, -1);
    const plan = await this.modelCall(sessionId, () => this.dependencies.brain.plan(request,
      conversation.map(turn => turn.text), sessionId, initialEvidence, conversation));
    if (plan.kind === 'answer') {
      const grounded = plan.evidence && plan.evidenceQuote && plan.evidenceQuote.length >= 12 &&
        plan.evidence.excerpt.includes(plan.evidenceQuote) &&
        initialEvidence.some(item => item.path === plan.evidence?.path && item.url === plan.evidence?.url &&
          item.excerpt === plan.evidence?.excerpt);
      if (this.dependencies.code.name === 'github' && isRepositoryQuestion(request) && !grounded) {
        if (!initialEvidence.length) {
          await this.speakOrChat(sessionId, s.meeting, missingCodeEvidenceMessage(this.dependencies.code));
          return 'answered';
        }
        const spoken = await this.modelCall(sessionId, () => this.dependencies.brain.answerWithEvidence(request, initialEvidence, sessionId));
        await this.speakOrChat(sessionId, s.meeting, withCodeCoverageNotice(this.dependencies.code, spoken));
        await s.meeting.sendCompletion({ provider: this.dependencies.code.name, kind: 'code_lookup',
          url: initialEvidence[0]!.url, label: 'Code reference' });
        return 'completed';
      }
      await this.speakOrChat(sessionId, s.meeting,
        grounded && plan.evidence ? withCodeCoverageNotice(this.dependencies.code, plan.message) : plan.message);
      if (grounded && plan.evidence) {
        await s.meeting.sendCompletion({ provider: this.dependencies.code.name, kind: 'code_lookup',
          url: plan.evidence.url, label: 'Code reference' });
        return 'completed';
      }
      return 'answered';
    }
    if (plan.kind === 'inspect_code') {
      if (!this.dependencies.policy.mayReadCode(utterance.actor)) {
        await this.speakOrChat(sessionId, s.meeting, 'Sorry, I can’t look at the project code for you.');
        return 'denied';
      }
      let evidence: Evidence[];
      try { evidence = await this.dependencies.code.findEvidence(`${request}\n${plan.query}`); }
      catch (error) {
        await this.speakOrChat(sessionId, s.meeting,
          error instanceof CodeLookupRateLimitError
            ? 'GitHub’s rate limit is blocking me right now. Give it a few minutes and ask again.'
            : 'I could not check the repository right now. The connection needs attention; please try again later.');
        return 'answered';
      }
      this.dependencies.usage?.recordExternalAction(sessionId, 'code_lookup');
      if (!evidence.length) {
        await this.speakOrChat(sessionId, s.meeting, missingCodeEvidenceMessage(this.dependencies.code));
        return 'answered';
      }
      const spoken = await this.modelCall(sessionId, () => this.dependencies.brain.answerWithEvidence(request, evidence, sessionId));
      await this.speakOrChat(sessionId, s.meeting, withCodeCoverageNotice(this.dependencies.code, spoken));
      await s.meeting.sendCompletion({
        provider: this.dependencies.code.name, kind: 'code_lookup', url: evidence[0]!.url,
        label: 'Code reference',
      });
      return 'completed';
    }
    if (plan.kind === 'create_task') {
      if (!isExplicitCreateRequest(request) || !this.dependencies.policy.mayWriteTask(utterance.actor)) {
        await this.speakOrChat(sessionId, s.meeting, 'I need an explicit authorized request to create a task.');
        return 'denied';
      }
      if (!plan.title.trim() || plan.title.length > 200) {
        await this.speakOrChat(sessionId, s.meeting, 'Sure, what should the task be about?');
        return 'denied';
      }
      // One acknowledgement on a direct address; never speak again on completion.
      await this.speakOrChat(sessionId, s.meeting, 'I will create the task and post its link in the meeting chat.');
      const id = `${sessionId}:${utterance.eventId}`;
      let receipt = this.completed.get(id);
      if (!receipt) {
        receipt = await this.dependencies.board.createTask({
          title: plan.title, description: plan.description, assigneeId: plan.assigneeId, requestId: id,
        });
        this.completed.set(id, receipt);
        this.dependencies.usage?.recordExternalAction(sessionId, 'create_task');
      }
      await s.meeting.sendCompletion(receipt);
      return 'completed';
    }
    // No unsafe placeholder: draft PR remains intentionally denied.
    if (!isExplicitPRRequest(request) || !this.dependencies.policy.mayDraftPR(utterance.actor)) {
      await this.speakOrChat(sessionId, s.meeting, 'I can’t open pull requests yet, sorry. I can make a task for it instead.');
      return 'not_supported';
    }
    return 'not_supported';
    } catch (error) {
      s.eventIds.delete(utterance.eventId);
      if (released) {
        // Other utterances were heard meanwhile: remove only this one.
        const index = historyEntry ? s.history.indexOf(historyEntry) : -1;
        if (index >= 0) s.history.splice(index, 1);
      } else s.history.splice(0, s.history.length, ...historyBefore);
      s.pendingFollowUp = pendingBefore;
      s.raised = raisedBefore;
      s.mutedUntil = mutedUntilBefore;
      throw error;
    }
    } finally {
      if (context.speculation && !adopted) context.speculation.cancel();
      this.clearProgressTimer(s);
      if (s.progressSpeech) await s.progressSpeech;
      s.activeRequest = undefined;
      this.dependencies.usage?.recordResponse?.(sessionId, performance.now() - processingStartedAt);
      release();
    }
  }
}
