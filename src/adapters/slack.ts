import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActionReceipt, Capability, MeetingPort } from '../core/contracts.ts';

export function verifySlackSignature(secret: string, timestamp: string | null, signature: string | null,
                                     rawBody: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const digest = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const expected = Buffer.from(digest);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class SlackThreadMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability> = new Set(['chat_receipt']);
  constructor(readonly id: string, private readonly token: string,
    private readonly channel: string, private readonly threadTs: string,
    private readonly http: typeof fetch = fetch) {}
  async join(): Promise<void> { /* Slack is not a voice meeting; invoked by explicit mention. */ }
  async speak(message: string): Promise<void> { await this.post(message); }
  async raiseHand(): Promise<boolean> { return false; }
  async sendCompletion(receipt: ActionReceipt): Promise<void> { await this.post(`${receipt.label}: ${receipt.url}`); }
  async leave(): Promise<void> {}
  private async post(text: string): Promise<void> {
    if (!this.token || !this.channel || !this.threadTs) throw new Error('Slack channel/token missing');
    const res = await this.http('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: this.channel, thread_ts: this.threadTs, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Slack API HTTP ${res.status}`);
    const result = await res.json() as { ok?: boolean; error?: string };
    if (!result.ok) throw new Error(`Slack rejected post: ${result.error ?? 'unknown'}`);
  }
}
