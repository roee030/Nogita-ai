import type { ActionReceipt, BoardPort, BrainPort, CodePort, MeetingPort, PolicyPort, Utterance } from './contracts.ts';
import { directlyAddressesNogita, isExplicitCreateRequest, isExplicitPRRequest, removeAddress } from './policy.ts';

interface Session {
  meeting: MeetingPort;
  history: string[]; // ephemeral: purged when session ends
  eventIds: Set<string>;
  raised: boolean;
  mutedUntil: number;
  processing: Promise<void>;
  ending: boolean;
}
export type ProcessResult = 'ignored' | 'raised_hand' | 'answered' | 'completed' | 'denied' | 'not_supported';

export class NogitaEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly completed = new Map<string, ActionReceipt>(); // Process-local; durable idempotency is TODO.
  constructor(private readonly dependencies: {
    board: BoardPort;
    code: CodePort;
    brain: BrainPort;
    policy: PolicyPort;
  }) {}

  private addSession(sessionId: string, meeting: MeetingPort): void {
    if (this.sessions.has(sessionId)) throw new Error('session already exists');
    if (!sessionId || sessionId.length > 100) throw new Error('invalid session id');
    this.sessions.set(sessionId, {
      meeting, history: [], eventIds: new Set(), raised: false, mutedUntil: 0,
      processing: Promise.resolve(), ending: false,
    });
  }

  async startSession(sessionId: string, meeting: MeetingPort, meetingUrl?: string): Promise<void> {
    if (this.sessions.has(sessionId)) throw new Error('session already exists');
    if (!sessionId || sessionId.length > 100) throw new Error('invalid session id');
    await meeting.join(meetingUrl);
    this.addSession(sessionId, meeting);
  }
  restoreSession(sessionId: string, meeting: MeetingPort): void { this.addSession(sessionId, meeting); }
  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }
  async endSession(sessionId: string, leaveProvider = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ending = true;
    await session.processing;
    if (this.sessions.get(sessionId) !== session) return;
    this.sessions.delete(sessionId);
    session.history.length = 0;
    session.eventIds.clear();
    for (const key of this.completed.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.completed.delete(key);
    }
    if (leaveProvider) await session.meeting.leave();
  }
  sessionCount(): number { return this.sessions.size; }

  async onUtterance(sessionId: string, utterance: Utterance): Promise<ProcessResult> {
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
    const request = removeAddress(current);
    const plan = await this.dependencies.brain.plan(request, s.history.slice(0, -1));
    if (plan.kind === 'answer') {
      await s.meeting.speak(plan.message);
      return 'answered';
    }
    if (plan.kind === 'inspect_code') {
      if (!this.dependencies.policy.mayReadCode(utterance.actor)) {
        await s.meeting.speak('I cannot access restricted project code for this request.');
        return 'denied';
      }
      const evidence = await this.dependencies.code.findEvidence(plan.query);
      if (!evidence.length) {
        await s.meeting.speak('I could not find enough code evidence to answer that reliably.');
        return 'answered';
      }
      const spoken = await this.dependencies.brain.answerWithEvidence(request, evidence);
      await s.meeting.speak(spoken);
      await s.meeting.sendCompletion({
        provider: this.dependencies.code.name, kind: 'code_lookup', url: evidence[0]!.url,
        label: 'Code reference',
      });
      return 'completed';
    }
    if (plan.kind === 'create_task') {
      if (!isExplicitCreateRequest(request) || !this.dependencies.policy.mayWriteTask(utterance.actor)) {
        await s.meeting.speak('I need an explicit authorized request to create a task.');
        return 'denied';
      }
      if (!plan.title.trim() || plan.title.length > 200) {
        await s.meeting.speak('Please give me a clear task title.');
        return 'denied';
      }
      // One acknowledgement on a direct address; never speak again on completion.
      await s.meeting.speak('I will create the task and post its link in the meeting chat.');
      const id = `${sessionId}:${utterance.eventId}`;
      let receipt = this.completed.get(id);
      if (!receipt) {
        receipt = await this.dependencies.board.createTask({
          title: plan.title, description: plan.description, assigneeId: plan.assigneeId, requestId: id,
        });
        this.completed.set(id, receipt);
      }
      await s.meeting.sendCompletion(receipt);
      return 'completed';
    }
    // No unsafe placeholder: draft PR remains intentionally denied.
    if (!isExplicitPRRequest(request) || !this.dependencies.policy.mayDraftPR(utterance.actor)) {
      await s.meeting.speak('Draft pull requests are not enabled yet. I will not change code without an approved workflow.');
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
      release();
    }
  }
}
