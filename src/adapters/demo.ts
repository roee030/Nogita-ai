import type { ActionReceipt, BoardPort, BrainPort, Capability, CodePort, CreateTask, Evidence, MeetingPort, Plan } from '../core/contracts.ts';

export class DemoMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability> = new Set(['listen', 'speak', 'raise_hand', 'chat_receipt']);
  readonly events: Array<{ type: string; text?: string }> = [];
  constructor(readonly id: string) {}
  async join(): Promise<void> { this.events.push({ type: 'join' }); }
  async speak(message: string): Promise<void> { this.events.push({ type: 'speak', text: message }); }
  async sendStatus(message: string): Promise<void> { this.events.push({ type: 'chat', text: message }); }
  async raiseHand(): Promise<boolean> { this.events.push({ type: 'raise_hand' }); return true; }
  async sendCompletion(receipt: ActionReceipt): Promise<void> {
    await this.sendStatus(`${receipt.label}: ${receipt.url}`);
  }
  async leave(): Promise<void> { this.events.push({ type: 'leave' }); }
}

export class DemoBoard implements BoardPort {
  readonly name = 'demo-jira';
  readonly tasks: CreateTask[] = [];
  async createTask(input: CreateTask): Promise<ActionReceipt> {
    this.tasks.push(input);
    return { provider: this.name, kind: 'task', label: `DEMO-${this.tasks.length}`, url: `https://example.invalid/DEMO-${this.tasks.length}` };
  }
}
export class DemoCode implements CodePort {
  readonly name = 'demo-github';
  async findEvidence(query: string): Promise<Evidence[]> {
    return [{ path: 'src/auth/session.ts', url: 'https://example.invalid/demo/src/auth/session.ts#L10',
      excerpt: `DEMO FIXTURE for '${query}': createSession() validates session tokens before returning a user.` }];
  }
}
/** Deterministic demonstration planner, NOT a substitute for LLM reasoning. */
export class DemoBrain implements BrainPort {
  async plan(current: string): Promise<Plan> {
    const t = current.toLowerCase();
    if (/(pull request|\bpr\b)/i.test(current)) return { kind: 'draft_pr', instruction: current };
    if (/(create|open|add|file|make).{0,90}(task|ticket|issue|bug|story)/i.test(current)) {
      const title = current.replace(/^(?:please\s+)?(?:create|open|add|file|make)\s+(?:a|an)\s+(?:jira\s+)?(?:task|ticket|issue|bug|story)\s*(?:to|for|about|:)?\s*/i, '').trim();
      return { kind: 'create_task', title: title || 'Follow up on meeting discussion', description: `Requested during meeting: ${current}` };
    }
    if (/(code|repository|repo|implement|implemented|function|authentication|auth|login)/.test(t)) {
      return { kind: 'inspect_code', query: current };
    }
    return { kind: 'answer', message: `I'm here. You asked: ${current}` };
  }
  async answerWithEvidence(_question: string, evidence: readonly Evidence[]): Promise<string> {
    return `From the available code: ${evidence[0]?.excerpt ?? 'No code found.'} I've posted the source link in chat.`;
  }
  async suggestContribution(history: readonly string[]): Promise<boolean> {
    // Only a demo signal. Real risk detection requires corroboration, no chat or voice.
    return /\b(critical security risk|severe vulnerability)\b/i.test(history.at(-1) ?? '');
  }
}
