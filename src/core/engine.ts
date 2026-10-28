import { CodeLookupRateLimitError, SpeechFallbackSentError, type ActionReceipt, type BoardPort, type BrainPort, type ChatPort, type CodePort, type ConversationTurn, type Evidence,
  type MeetingPort, type PolicyPort, type UsagePort, type Utterance } from './contracts.ts';
import { runAgent, type ChatModel } from './agent.ts';
import { buildToolbox, type PeopleDirectory } from './agent-tools.ts';
import { agentUserMessage, stableAgentPrompt, turnAgentPrompt } from './agent-prompt.ts';
import { directlyAddressesNogita, isExplicitCreateRequest, isExplicitPRRequest,
  isRepositoryConnectionQuestion, isRepositoryOverviewQuestion, isRepositoryQuestion, removeAddress } from './policy.ts';

interface Session {
  meeting: MeetingPort;
  history: ConversationTurn[]; // ephemeral: purged when session ends
  pendingFollowUp?: { actorId: string; request: string; question: string; expiresAt: number; afterSequence: number };
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
}
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
}

function isAffirmativeFollowUp(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[,]+/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:yes|yes please|yeah|yeah please|sure|sure please|please do|go ahead|i want to know(?: the answer(?: to (?:that|the question))?)?|i would like to know(?: the answer)?)$/.test(normalized);
}

const progressPhrases = [
  'Let me think for a moment.',
  'One second, I’m checking that.',
  'Hmm, I want to get this right.',
  'Give me a moment to work through it.',
  'I’m on it; just checking the details.',
  'Just a sec, I’m putting that together.',
  'Let me make sure I understand.',
  'I’m checking the relevant details now.',
  'Hang on a moment; I’ll make sure I have this right.',
];
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
const MAX_SPOKEN_WORDS = 90;
const STILL_WORKING = ['Still checking, one more moment.', 'Almost there.', 'Still on it.'];
/** Markdown and URLs read badly through text-to-speech; the chat copy keeps them. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
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
    this.now = options.now ?? Date.now;
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
      processing: Promise.resolve(), ending: false,
    });
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
          afterSequence: session.lastArrivalSequence };
      }
    }
  }

  private async deliverSpeech(sessionId: string, meeting: MeetingPort, message: string): Promise<void> {
    const active = this.sessions.get(sessionId)?.activeRequest;
    if (active && !active.firstSpeechRecorded) {
      active.firstSpeechRecorded = true;
      this.dependencies.usage?.recordResponseStage?.(sessionId, 'turn_to_first_speech_attempt', performance.now() - active.startedAt);
    }
    try {
      await meeting.speak(message);
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

  private beginProgressAcknowledgment(sessionId: string, session: Session, delayMs = this.progressDelayMs): void {
    session.progressSpeech = undefined;
    session.progressTimer = this.schedule(() => {
      session.progressTimer = undefined;
      if (this.sessions.get(sessionId) !== session || session.ending) return;
      const choices = progressPhrases.filter(phrase => phrase !== session.lastProgressPhrase);
      const selected = Math.min(choices.length - 1, Math.max(0, Math.floor(this.random() * choices.length)));
      const phrase = choices[selected]!;
      session.lastProgressPhrase = phrase;
      session.progressSpeech = this.deliverSpeech(sessionId, session.meeting, phrase).catch(() => undefined);
      return session.progressSpeech;
    }, delayMs);
  }

  /** Interim human speech cancels unsent filler for the prior turn. */
  cancelProgressForSpeechActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ending || session.progressTimer === undefined) return;
    this.clearProgressTimer(session);
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

  /** Speech for a streamed chunk: no chat mirror (the whole answer goes to chat once) and no chat fallback. */
  private async deliverStreamedSpeech(sessionId: string, meeting: MeetingPort, text: string): Promise<void> {
    const active = this.sessions.get(sessionId)?.activeRequest;
    if (active && !active.firstSpeechRecorded) {
      active.firstSpeechRecorded = true;
      this.dependencies.usage?.recordResponseStage?.(sessionId, 'turn_to_first_speech_attempt', performance.now() - active.startedAt);
    }
    try {
      await meeting.speak(text, { chatMirror: false });
      this.dependencies.usage?.recordTts(sessionId, true);
    } catch {
      this.dependencies.usage?.recordTts(sessionId, false);
    }
  }

  /**
   * One direct request answered by the tool-using agent. Returns undefined when the agent failed before
   * saying or changing anything, so the caller can fall back to the planner.
   */
  private async runAgentTurn(sessionId: string, s: Session, utterance: Utterance, request: string,
    pending: Session['pendingFollowUp']): Promise<ProcessResult | undefined> {
    const agent = this.dependencies.agent!;
    const raisedReason = s.raisedReason;
    s.raisedReason = undefined;
    const voice = s.meeting.capabilities.has('speak');
    const speaker = utterance.actor.displayName;
    const authorized = this.dependencies.policy.mayReadCode(utterance.actor);
    const writeScope = pending ? `${pending.request}\n${request}` : request;
    let userText = pending ? `(Your previous message to ${speaker} was: "${pending.question}")\n${request}` : request;
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
    });
    // A text thread carries its own history (including messages that never addressed Nogita).
    let transcript = s.history.slice(0, -1).map(turn => turn.text);
    if (s.meeting.recentContext) {
      const thread = await Promise.race([s.meeting.recentContext().catch(() => [] as string[]),
        new Promise<string[]>(resolve => setTimeout(() => resolve([]), 2_000))]);
      if (thread.length) transcript = thread.slice(0, -1);
    }
    let spoke = false;
    let speech = Promise.resolve();
    let spokenWords = 0;
    let truncatedSpeech = false;
    let stillWorking: unknown;
    let stillWorkingUsed = false;
    const queueSpeech = (text: string) => {
      speech = speech.then(async () => {
        if (s.progressSpeech) await s.progressSpeech;
        await this.deliverStreamedSpeech(sessionId, s.meeting, text);
      });
    };
    const onSpeech = (raw: string) => {
      if (!spoke) {
        spoke = true;
        this.clearProgressTimer(s);
      }
      if (stillWorking !== undefined) { this.cancel(stillWorking); stillWorking = undefined; }
      const text = speakable(raw);
      if (!text || truncatedSpeech) return;
      // Spoken answers stay short; anything longer is in the chat copy of the answer.
      const words = text.split(/\s+/).length;
      if (spokenWords > 0 && spokenWords + words > MAX_SPOKEN_WORDS) {
        truncatedSpeech = true;
        queueSpeech('I have put the rest in the chat.');
        return;
      }
      spokenWords += words;
      queueSpeech(text);
      // After a spoken lead-in, a long silence while tools run gets one short "still on it".
      if (!stillWorkingUsed) {
        stillWorking = this.schedule(() => {
          stillWorking = undefined;
          if (stillWorkingUsed || truncatedSpeech || this.sessions.get(sessionId) !== s) return;
          stillWorkingUsed = true;
          queueSpeech(STILL_WORKING[Math.floor(this.random() * STILL_WORKING.length) % STILL_WORKING.length]!);
        }, 6_000);
      }
    };
    let result;
    try {
      result = await this.modelCall(sessionId, () => runAgent(agent, {
        stableSystem: stableAgentPrompt({ voice,
          repository: repository && { name: this.dependencies.code.name, ...repository },
          boardName: authorized ? this.dependencies.board.name : undefined,
          chatName: authorized ? this.dependencies.chat?.name : undefined }),
        turnSystem: turnAgentPrompt({ speaker, authorized, nowIso: new Date(this.now()).toISOString(), followUp: pending !== undefined,
          raisedHandReason: raisedReason }),
        messages: [{ role: 'user', content: agentUserMessage(transcript, speaker, userText) }],
        toolbox, stream: voice, onSpeech: voice ? onSpeech : undefined, usageContext: sessionId,
        deadlineMs: voice ? 45_000 : 90_000, maxTokens: voice ? 600 : 1_500, maxSteps: voice ? 5 : 8,
      }));
    } catch {
      if (stillWorking !== undefined) this.cancel(stillWorking);
      await speech;
      if (!spoke && !report.wroteSomething) return undefined;
      this.clearProgressTimer(s);
      await this.speakOrChat(sessionId, s.meeting, 'Sorry, I hit a problem and could not finish that.');
      return report.wroteSomething ? 'completed' : 'answered';
    }
    if (stillWorking !== undefined) { this.cancel(stillWorking); stillWorking = undefined; }
    stillWorkingUsed = true;
    await speech;
    this.clearProgressTimer(s);
    if (s.progressSpeech) await s.progressSpeech;
    let answer = result.answer;
    if (!answer && result.stoppedEarly) answer = 'That is taking me too long. Ask me again with a narrower question.';
    if (!answer) return spoke || report.wroteSomething ? (report.wroteSomething ? 'completed' : 'answered') : 'ignored';
    if (voice) {
      // The final answer was spoken while it streamed (unless the turn was cut short); chat gets it once.
      if (!result.answer) await this.deliverStreamedSpeech(sessionId, s.meeting, answer);
      try { await s.meeting.sendStatus(answer); } catch { /* Speech already delivered; chat is best effort. */ }
      s.history.push({ role: 'assistant', text: `Nogita: ${answer}` });
      if (s.history.length > 24) s.history.shift();
    } else {
      await this.speakOrChat(sessionId, s.meeting, answer);
    }
    if (answer.trim().endsWith('?')) {
      s.pendingFollowUp = { actorId: utterance.actor.id, request: writeScope, question: answer,
        expiresAt: this.now() + 60_000, afterSequence: s.lastArrivalSequence };
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

  async onUtterance(sessionId: string, utterance: Utterance): Promise<ProcessResult> {
    const processingStartedAt = performance.now();
    const s = this.sessions.get(sessionId);
    if (!s || s.ending) throw new Error('unknown session');
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
    const current = utterance.text.trim().slice(0, 4000);
    s.history.push({ role: 'user', text: `${utterance.actor.displayName}: ${current}` });
    if (s.history.length > 24) s.history.shift();

    const directlyAddressed = directlyAddressesNogita(current);
    const pending = s.pendingFollowUp;
    const continuation = !directlyAddressed && pending !== undefined &&
      pending.actorId === utterance.actor.id && arrivalSequence > pending.afterSequence &&
      this.now() <= pending.expiresAt &&
      // The agent can tell a real reply from unrelated talk (it answers with silence); the planner cannot.
      (this.dependencies.agent !== undefined || isAffirmativeFollowUp(current));
    if (!directlyAddressed && !continuation) {
      if (pending?.actorId === utterance.actor.id) s.pendingFollowUp = undefined;
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
    if (this.dependencies.agent) {
      this.beginProgressAcknowledgment(sessionId, s, this.agentProgressDelayMs);
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
        await this.speakOrChat(sessionId, s.meeting, 'I cannot access restricted project code for this request.');
        return 'denied';
      }
      let evidence;
      try {
        evidence = await this.dependencies.code.findEvidence('README package.json');
      } catch {
        await this.speakOrChat(sessionId, s.meeting,
          'I tried to check the repository, but GitHub refused the request. My server connection needs attention.');
        return 'answered';
      }
      this.dependencies.usage?.recordExternalAction(sessionId, 'code_lookup');
      if (!evidence.length) {
        await this.speakOrChat(sessionId, s.meeting, 'I could not verify a live repository connection.');
        return 'answered';
      }
      await this.speakOrChat(sessionId, s.meeting,
        'Yes. I have live read-only access to the configured GitHub repository.');
      await s.meeting.sendCompletion({
        provider: this.dependencies.code.name, kind: 'code_lookup', url: evidence[0]!.url,
        label: 'Code reference',
      });
      return 'completed';
    }
    let initialEvidence: Evidence[] = [];
    if (this.dependencies.code.name === 'github' && isRepositoryQuestion(request) &&
        !this.dependencies.policy.mayReadCode(utterance.actor)) {
      await this.speakOrChat(sessionId, s.meeting, 'I cannot access restricted project code for this request.');
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
          'GitHub has reached its rate limit. I cannot check the repository right now; please try again later.');
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
        await this.speakOrChat(sessionId, s.meeting, 'I cannot access restricted project code for this request.');
        return 'denied';
      }
      let evidence: Evidence[];
      try { evidence = await this.dependencies.code.findEvidence(`${request}\n${plan.query}`); }
      catch (error) {
        await this.speakOrChat(sessionId, s.meeting,
          error instanceof CodeLookupRateLimitError
            ? 'GitHub has reached its rate limit. I cannot check the repository right now; please try again later.'
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
        await this.speakOrChat(sessionId, s.meeting, 'Please give me a clear task title.');
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
      await this.speakOrChat(sessionId, s.meeting, 'Draft pull requests are not enabled yet. I will not change code without an approved workflow.');
      return 'not_supported';
    }
    return 'not_supported';
    } catch (error) {
      s.eventIds.delete(utterance.eventId);
      s.history.splice(0, s.history.length, ...historyBefore);
      s.pendingFollowUp = pendingBefore;
      s.raised = raisedBefore;
      s.mutedUntil = mutedUntilBefore;
      throw error;
    }
    } finally {
      this.clearProgressTimer(s);
      if (s.progressSpeech) await s.progressSpeech;
      s.activeRequest = undefined;
      this.dependencies.usage?.recordResponse?.(sessionId, performance.now() - processingStartedAt);
      release();
    }
  }
}
