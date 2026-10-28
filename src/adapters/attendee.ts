import { SpeechFallbackSentError, type ActionReceipt, type Capability, type MeetingPort, type SpeakOptions, type SpeechStage } from '../core/contracts.ts';

const AUDIO_SAMPLE_RATE = 16_000;

/**
 * Attendee meeting control adapter (API v1).
 * Supports join, English TTS output, and completion messages.
 * Incoming realtime audio + wake-word detection are NOT wired yet.
 *
 * API: https://docs.attendee.dev/api-reference/tag/bots
 */
export class AttendeeMeeting implements MeetingPort {
  readonly capabilities: ReadonlySet<Capability>;
  private botId?: string;
  private readonly endpoint = 'https://app.attendee.dev/api/v1/bots';

  constructor(
    readonly id: string,
    private readonly apiKey: string,
    private readonly privacyReviewed: boolean,
    private readonly http: typeof fetch = fetch,
    private readonly webhookUrl?: string,
    private readonly initialChatMessage?: string,
    private readonly synthesizeSpeech?: (text: string) => Promise<Buffer>,
    private readonly recordSpeechDuration?: (stage: SpeechStage, durationMs: number) => void,
    private readonly realtimeAudioUrl?: string,
    private readonly streamSpeech?: (text: string) => Promise<void>,
  ) {
    if (!apiKey.trim()) throw new Error('ATTENDEE_API_KEY is required');
    if (webhookUrl) {
      const url = new URL(webhookUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Attendee webhook URL must use HTTPS');
    }
    this.capabilities = new Set(webhookUrl ? ['listen', 'speak', 'chat_receipt'] : ['speak', 'chat_receipt']);
  }

  get botIdentifier(): string | undefined { return this.botId; }

  /** Reconnect local control to a bot that this service created before a restart. */
  attach(botId: string): void {
    if (this.botId) throw new Error('Attendee bot is already joining/joined');
    if (!/^bot_[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('Attendee bot ID is not a valid ID');
    this.botId = botId;
  }

  private async request(path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const response = await this.http(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
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
      metadata: { session_id: this.id },
      automatic_leave_settings: {
        silence_timeout_seconds: 180,
        only_participant_in_meeting_timeout_seconds: 30,
      },
      ...(this.webhookUrl ? { webhooks: [{
        url: this.webhookUrl,
        triggers: ['bot.state_change', 'transcript.update', 'participant_events.join_leave', 'bot_logs.update'],
      }] } : {}),
      ...(this.initialChatMessage?.trim() ? {
        bot_chat_message: { to: 'everyone', message: this.initialChatMessage },
      } : {}),
      debug_settings: { create_debug_recording: false },
      ...(this.realtimeAudioUrl ? { websocket_settings: { per_participant_audio: {
        url: this.realtimeAudioUrl, sample_rate: AUDIO_SAMPLE_RATE,
      } } } : {}),
    }) as { id?: string } | undefined;
    if (!data?.id || !/^bot_[a-zA-Z0-9_-]+$/.test(data.id)) {
      throw new Error('Attendee bot creation did not return a valid ID');
    }
    this.botId = data.id;
  }

  /** TTS output is gated by NogitaEngine's direct-name policy, not by this provider. */
  async speak(message: string, options: SpeakOptions = {}): Promise<void> {
    if (!this.botId) throw new Error('not joined');
    if (!message.trim()) throw new Error('empty spoken message');
    const speechStarted = performance.now();
    // Attendee acknowledges queued TTS but does not prove that an unmuted client played it.
    // Start the chat mirror and audio together so chat latency does not delay speech.
    // Streamed partial answers skip the mirror: the engine posts the whole answer to chat once.
    const chatStarted = performance.now();
    const mirror = options.chatMirror === false ? Promise.resolve(false)
      : this.sendStatus(message).then(() => true, () => false)
        .finally(() => this.recordSpeechDuration?.('chat_mirror', performance.now() - chatStarted));
    try {
      try {
        if (this.streamSpeech) {
          const submissionStarted = performance.now();
          try { await this.streamSpeech(message); }
          finally { this.recordSpeechDuration?.('audio_submission', performance.now() - submissionStarted); }
        } else if (this.synthesizeSpeech) {
          const synthesisStarted = performance.now();
          let audio: Buffer;
          try { audio = await this.synthesizeSpeech(message); }
          finally { this.recordSpeechDuration?.('tts_synthesis', performance.now() - synthesisStarted); }
          const submissionStarted = performance.now();
          try {
            await this.request(`/${this.botId}/output_audio`, { type: 'audio/mp3', data: audio.toString('base64') });
          } finally { this.recordSpeechDuration?.('audio_submission', performance.now() - submissionStarted); }
        } else {
          const submissionStarted = performance.now();
          try {
            await this.request(`/${this.botId}/speech`, {
              text: message,
              text_to_speech_settings: { google: { voice_language_code: 'en-US', voice_name: 'en-US-Casual-K' } },
            });
          } finally { this.recordSpeechDuration?.('audio_submission', performance.now() - submissionStarted); }
        }
      } catch (error) {
        if (await mirror) throw new SpeechFallbackSentError();
        throw error;
      }
      await mirror;
    } finally { this.recordSpeechDuration?.('speech_submission', performance.now() - speechStarted); }
  }

  async sendStatus(message: string, timeoutMs = 5_000): Promise<void> {
    if (!this.botId) throw new Error('not joined');
    if (!message.trim()) throw new Error('empty chat message');
    await this.request(`/${this.botId}/send_chat_message`, { to: 'everyone', message }, timeoutMs);
  }

  /** No documented native hand raise API. NEVER replace a hand raise with speech. */
  async raiseHand(): Promise<boolean> { return false; }

  async sendCompletion(receipt: ActionReceipt): Promise<void> {
    await this.sendStatus(`${receipt.label}: ${receipt.url}`);
  }

  async leave(): Promise<void> {
    const botId = this.botId;
    if (!botId) return;
    await this.request(`/${botId}/leave`);
    this.botId = undefined;
  }
}
