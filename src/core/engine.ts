import { CodeLookupRateLimitError, SpeechFallbackSentError, type ActionReceipt, type BoardPort, type BrainPort, type CodePort, type ConversationTurn, type Evidence,
  type MeetingPort, type PolicyPort, type UsagePort, type Utterance } from './contracts.ts';
import { directlyAddressesNogita, isExplicitCreateRequest, isExplicitPRRequest,
  isRepositoryConnectionQuestion, isRepositoryQuestion, removeAddress } from './policy.ts';

interface Session {
  meeting: MeetingPort;
  history: ConversationTurn[]; // ephemeral: purged when session ends
  pendingFollowUp?: { actorId: string; request: string; question: string; expiresAt: number; afterSequence: number };
  activeRequest?: { actorId: string; request: string };
  lastArrivalSequence: number;
  eventIds: Set<string>;
  raised: boolean;
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
export type ProcessResult = 'ignored' | 'raised_hand' | 'answered' | 'completed' | 'denied' | 'not_supported';

export class NogitaEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly startingSessions = new Set<string>();
  private readonly completed = new Map<string, ActionReceipt>(); // Process-local; durable idempotency is TODO.
  private readonly progressDelayMs: number;
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
  }, options: NogitaEngineOptions = {}) {
    this.progressDelayMs = options.progressDelayMs ?? 4_500;
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
    this.sessions.set(sessionId, {
      meeting, history: [], lastArrivalSequence: 0, eventIds: new Set(), raised: false, mutedUntil: 0,
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
    try {
      await meeting.speak(message);
      this.dependencies.usage?.recordTts(sessionId, true);
    } catch (error) {
      this.dependencies.usage?.recordTts(sessionId, false);
      if (!(error instanceof SpeechFallbackSentError)) await meeting.sendStatus(message);
    }
  }

  private clearProgressTimer(session: Session): void {
    if (session.progressTimer === undefined) return;
    this.cancel(session.progressTimer);
    session.progressTimer = undefined;
  }

  private beginProgressAcknowledgment(sessionId: string, session: Session): void {
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
    }, this.progressDelayMs);
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
      isAffirmativeFollowUp(current);
    if (!directlyAddressed && !continuation) {
      if (pending?.actorId === utterance.actor.id) s.pendingFollowUp = undefined;
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
    if (continuation) {
      try { await s.meeting.sendStatus('I heard your reply. I’m continuing that question.'); }
      catch { /* Chat is best effort; spoken answer still proceeds. */ }
    }
    this.beginProgressAcknowledgment(sessionId, s);
    const request = directlyAddressed ? removeAddress(current)
      : pending && /\b(?:repo|repository|github|code)\b/i.test(pending.question)
        ? `${pending.request} repository` : current;
    s.activeRequest = { actorId: utterance.actor.id, request };
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
        initialEvidence = await this.dependencies.code.findEvidence(request);
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
    const plan = await this.dependencies.brain.plan(request, conversation.map(turn => turn.text),
      sessionId, initialEvidence, conversation);
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
        const spoken = await this.dependencies.brain.answerWithEvidence(request, initialEvidence, sessionId);
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
      const spoken = await this.dependencies.brain.answerWithEvidence(request, evidence, sessionId);
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
