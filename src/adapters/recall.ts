import type { ActionReceipt, Capability, MeetingPort } from '../core/contracts.ts';

/** Real Recall join/chat adapter. Audio bridge and native hand raise are NOT implemented. */
export class RecallMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability> = new Set(['chat_receipt']);
  private botId?: string;
  private readonly baseUrl: string;
  constructor(readonly id: string, private readonly apiKey: string,
    region: string = 'us-east-1', private readonly http: typeof fetch = fetch) {
    if (!apiKey || !['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'].includes(region)) {
      throw new Error('Recall API key or region missing/invalid');
    }
    this.baseUrl = `https://${region}.recall.ai/api/v1/bot/`;
  }
  private async post(path: string, payload: unknown): Promise<unknown> {
    const res = await this.http(new URL(path, this.baseUrl), {
      method: 'POST', headers: { Authorization: this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Recall API failed: HTTP ${res.status}`);
    return await res.json();
  }
  async join(meetingUrl?: string): Promise<void> {
    if (!meetingUrl) throw new Error('meeting URL required');
    const u = new URL(meetingUrl);
    if (u.protocol !== 'https:' || !(
      u.hostname === 'meet.google.com' ||
      u.hostname === 'zoom.us' || u.hostname.endsWith('.zoom.us') ||
      u.hostname === 'teams.microsoft.com' || u.hostname === 'teams.live.com')) {
      throw new Error('Meeting URL host not on approved allowlist');
    }
    // Intentionally not capturing recordings/transcripts. Audio streaming config requires a separate reviewed implementation.
    const response = await this.post('', { meeting_url: meetingUrl, bot_name: 'Nogita',
      recording_config: { retention: null } }) as { id?: string };
    if (!response.id || !/^[0-9a-f-]{36}$/i.test(response.id)) throw new Error('Recall bot was not created');
    this.botId = response.id;
  }
  async speak(_message: string): Promise<void> {
    throw new Error('Realtime voice not wired; cannot claim voice works');
  }
  async raiseHand(): Promise<boolean> { return false; }
  async sendCompletion(receipt: ActionReceipt): Promise<void> {
    if (!this.botId) throw new Error('not joined');
    await this.post(`${this.botId}/send_chat_message/`, { to: 'everyone', message: `${receipt.label}: ${receipt.url}` });
  }
  async leave(): Promise<void> {
    // Best effort: calls leave endpoint; not critical to replay in tests.
    if (!this.botId) return;
    try { await this.post(`${this.botId}/leave_call/`, {}); } catch { /* flagged in live integration report */ }
    this.botId = undefined;
  }
}
