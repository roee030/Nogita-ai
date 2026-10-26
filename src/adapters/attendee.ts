import type { ActionReceipt, Capability, MeetingPort } from '../core/contracts.ts';

/**
 * Attendee meeting control adapter (API v1).
 * Supports join, English TTS output, and completion messages.
 * Incoming realtime audio + wake-word detection are NOT wired yet.
 *
 * API: https://docs.attendee.dev/api-reference/tag/bots
 */
export class AttendeeMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability> = new Set(['speak', 'chat_receipt']);
  private botId?: string;
  private readonly endpoint = 'https://app.attendee.dev/api/v1/bots';

  constructor(
    readonly id: string,
    private readonly apiKey: string,
    private readonly privacyReviewed: boolean,
    private readonly http: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error('ATTENDEE_API_KEY is required');
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.http(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Attendee API failed: HTTP ${response.status}`);
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;
    const raw = await response.text();
    return raw ? JSON.parse(raw) as unknown : undefined;
  }

  async join(meetingUrl?: string): Promise<void> {
    if (this.botId) throw new Error('Attendee bot is already joining/joined');
    if (!this.privacyReviewed) {
      throw new Error('Attendee media recording/retention has not been reviewed for this workspace');
    }
    if (!meetingUrl || meetingUrl.length > 2048) throw new Error('valid meeting URL required');
    let target: URL;
    try { target = new URL(meetingUrl); }
    catch { throw new Error('invalid meeting URL'); }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || target.username || target.password || !(
      host === 'meet.google.com' || host === 'zoom.us' || host.endsWith('.zoom.us') ||
      host === 'teams.microsoft.com' || host === 'teams.live.com')) {
      throw new Error('Meeting URL host not on approved allowlist');
    }
    const data = await this.request('', {
      meeting_url: meetingUrl,
      bot_name: 'Nogita',
      deduplication_key: `nogita-${this.id}`,
      debug_settings: { create_debug_recording: false },
    }) as { id?: string } | undefined;
    if (!data?.id || !/^bot_[a-zA-Z0-9_-]+$/.test(data.id)) {
      throw new Error('Attendee bot creation did not return a valid ID');
    }
    this.botId = data.id;
  }

  /** TTS output is gated by NogitaEngine's direct-name policy, not by this provider. */
  async speak(message: string): Promise<void> {
    if (!this.botId) throw new Error('not joined');
    if (!message.trim()) throw new Error('empty spoken message');
    await this.request(`/${this.botId}/speech`, {
      text: message,
      text_to_speech_settings: { google: { voice_language_code: 'en-US', voice_name: 'en-US-Casual-K' } },
    });
  }

  /** No documented native hand raise API. NEVER replace a hand raise with speech. */
  async raiseHand(): Promise<boolean> { return false; }

  async sendCompletion(receipt: ActionReceipt): Promise<void> {
    if (!this.botId) throw new Error('not joined');
    await this.request(`/${this.botId}/send_chat_message`, {
      to: 'everyone',
      message: `${receipt.label}: ${receipt.url}`,
    });
  }

  async leave(): Promise<void> {
    const botId = this.botId;
    this.botId = undefined;
    if (!botId) return;
    await this.request(`/${botId}/leave`);
  }
}
