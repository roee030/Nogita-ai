import { SpeechFallbackSentError, type ActionReceipt, type BoardPort, type BrainPort, type CodePort,
  type MeetingPort, type PolicyPort, type UsagePort, type Utterance } from './contracts.ts';
import { directlyAddressesNogita, isExplicitCreateRequest, isExplicitPRRequest,
  isRepositoryConnectionQuestion, removeAddress } from './policy.ts';

interface Session {
  meeting: MeetingPort;
  history: string[]; // ephemeral: purged when session ends
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
}

const progressPhrases = [
  'Let me check that in the code.',
  'One second—I want to trace where that happens.',
  'Hmm, let me connect the pieces.',
  'Give me a moment; I’m checking the implementation.',
  'I’m looking at the relevant files now.',
  'Let me verify this against the repository.',
  'Just a sec—I want to be precise.',
  'Let me follow that through the code.',
  'I’m checking how those parts fit together.',
  'Hang on a moment; I’ll make sure I have this right.',
];
export type ProcessResult = 'ignored' | 'raised_hand' | 'answered' | 'completed' | 'denied' | 'not_supported';

export class NogitaEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly startingSessions = new Set<string>();
  private readonly completed = new Map<string, ActionReceipt>(); // Process-local; durable idempotency is TODO.
  private readonly progressDelayMs: number;
  private readonly schedule: (work: ProgressWork, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly random: () => number;
  constructor(private readonly dependencies: {
    board: BoardPort;
    code: CodePort;
    brain: BrainPort;
    policy: PolicyPort;
    usage?: UsagePort;
  }, options: NogitaEngineOptions = {}) {
    this.progressDelayMs = options.progressDelayMs ?? 900;
    this.schedule = options.schedule ?? ((work, delayMs) => setTimeout(() => { void work(); }, delayMs));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  private validateSessionId(sessionId: string): void {
    if (!sessionId || sessionId.length > 100) throw new Error('invalid session id');
  }

  private addSession(sessionId: string, meeting: MeetingPort): void {
    this.validateSessionId(sessionId);
    this.sessions.set(sessionId, {
      meeting, history: [], eventIds: new Set(), raised: false, mutedUntil: 0,
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
    const previous = s.processing;
    let release!: () => void;
    s.processing = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
    if (this.sessions.get(sessionId) !== s) throw new Error('unknown session');
    if (s.eventIds.has(utterance.eventId)) return 'ignored';
    s.eventIds.add(utterance.eventId);
    const historyBefore = s.history.slice();
    const raisedBefore = s.raised;
    const mutedUntilBefore = s.mutedUntil;
    try {
    // Prevent unbounded in-memory event metadata or transcript retention.
    if (s.eventIds.size > 2000) s.eventIds.delete(s.eventIds.values().next().value!);
    const current = utterance.text.trim().slice(0, 4000);
    s.history.push(`${utterance.actor.displayName}: ${current}`);
    if (s.history.length > 24) s.history.shift();

    if (!directlyAddressesNogita(current)) {
      if (!s.raised && Date.now() > s.mutedUntil && s.history.length > 1 &&
          await this.dependencies.brain.suggestContribution(s.history)) {
        const supported = await s.meeting.raiseHand();
        if (supported) { s.raised = true; s.mutedUntil = Date.now() + 5 * 60_000; return 'raised_hand'; }
      }
      return 'ignored';
    }

    // Asking Nogita to speak permits speech only here; raising a hand does not.
    s.raised = false;
    this.beginProgressAcknowledgment(sessionId, s);
    const request = removeAddress(current);
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
    const plan = await this.dependencies.brain.plan(request, s.history.slice(0, -1), sessionId);
    if (plan.kind === 'answer') {
      await this.speakOrChat(sessionId, s.meeting, plan.message);
      return 'answered';
    }
    if (plan.kind === 'inspect_code') {
      if (!this.dependencies.policy.mayReadCode(utterance.actor)) {
        await this.speakOrChat(sessionId, s.meeting, 'I cannot access restricted project code for this request.');
        return 'denied';
      }
      const evidence = await this.dependencies.code.findEvidence(`${request}\n${plan.query}`);
      this.dependencies.usage?.recordExternalAction(sessionId, 'code_lookup');
      if (!evidence.length) {
        await this.speakOrChat(sessionId, s.meeting, 'I could not find enough code evidence to answer that reliably.');
        return 'answered';
      }
      const spoken = await this.dependencies.brain.answerWithEvidence(request, evidence, sessionId);
      await this.speakOrChat(sessionId, s.meeting, spoken);
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
      s.raised = raisedBefore;
      s.mutedUntil = mutedUntilBefore;
      throw error;
    }
    } finally {
      this.clearProgressTimer(s);
      if (s.progressSpeech) await s.progressSpeech;
      this.dependencies.usage?.recordResponse?.(sessionId, performance.now() - processingStartedAt);
      release();
    }
  }
}
