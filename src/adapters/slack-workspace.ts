import type { ActionReceipt, ChatChannel, ChatMessage, ChatPort } from '../core/contracts.ts';

/**
 * Slack workspace access for the agent: channels the bot is a member of can be read and posted to.
 * Required bot scopes: channels:read, groups:read, channels:history, groups:history, users:read, chat:write.
 * Message search across channels needs a user token with search:read (optional).
 */
export class SlackWorkspace implements ChatPort {
  readonly name = 'slack';
  private channels?: { at: number; list: ChatChannel[] };
  private readonly users = new Map<string, string>();

  constructor(private readonly botToken: string, private readonly userToken?: string,
    private readonly http: typeof fetch = fetch, private readonly now = Date.now) {
    if (!botToken.startsWith('xoxb-')) throw new Error('Slack bot token must start with xoxb-');
    if (userToken && !userToken.startsWith('xoxp-')) throw new Error('Slack user token must start with xoxp-');
  }

  private async call(method: string, params: Record<string, string | number>, token = this.botToken,
    post = false): Promise<Record<string, unknown>> {
    const url = new URL(`https://slack.com/api/${method}`);
    const init: RequestInit = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) };
    if (post) {
      init.method = 'POST';
      (init.headers as Record<string, string>)['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(params);
    } else {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    }
    const response = await this.http(url, init);
    if (!response.ok) throw new Error(`Slack ${method} failed: HTTP ${response.status}`);
    const result = await response.json() as Record<string, unknown>;
    if (result.ok !== true) {
      const error = typeof result.error === 'string' ? result.error : 'unknown_error';
      const needed = typeof result.needed === 'string' ? ` (needs ${result.needed})` : '';
      throw new Error(`Slack ${method} rejected: ${error}${needed}`);
    }
    return result;
  }

  async listChannels(): Promise<ChatChannel[]> {
    if (this.channels && this.now() - this.channels.at < 5 * 60_000) return this.channels.list;
    const list: ChatChannel[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result = await this.call('conversations.list', { types: 'public_channel,private_channel',
        exclude_archived: 'true', limit: 200, ...(cursor ? { cursor } : {}) });
      for (const channel of (result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined) ?? []) {
        if (channel.is_member && channel.id && channel.name) list.push({ id: channel.id, name: channel.name });
      }
      cursor = ((result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor) ?? '';
      if (!cursor) break;
    }
    this.channels = { at: this.now(), list };
    return list;
  }

  /** Only channels the bot belongs to; names are matched without '#', case-insensitively. */
  private async resolve(channel: string): Promise<ChatChannel> {
    const wanted = channel.trim().replace(/^#/, '').toLowerCase();
    const found = (await this.listChannels()).find(item => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
    if (!found) throw new Error(`Nogita is not a member of #${wanted}. Invite the app to that channel first.`);
    return found;
  }

  private async userName(id: string | undefined): Promise<string> {
    if (!id) return 'someone';
    const cached = this.users.get(id);
    if (cached) return cached;
    try {
      const result = await this.call('users.info', { user: id });
      const user = result.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
      const name = user?.profile?.display_name || user?.real_name || user?.name || id;
      this.users.set(id, name);
      return name;
    } catch { return id; }
  }

  private async plain(text: string): Promise<string> {
    let out = text;
    for (const match of [...text.matchAll(/<@([A-Z0-9]+)>/g)]) out = out.replace(match[0], `@${await this.userName(match[1])}`);
    return out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  async readChannel(channel: string, limit = 20): Promise<ChatMessage[]> {
    const target = await this.resolve(channel);
    const result = await this.call('conversations.history', { channel: target.id, limit: Math.min(Math.max(limit, 1), 50) });
    const messages = (result.messages as Array<{ user?: string; text?: string; ts?: string; subtype?: string; bot_id?: string }> | undefined) ?? [];
    const out: ChatMessage[] = [];
    for (const message of messages.reverse()) {
      if (!message.text || (message.subtype && message.subtype !== 'thread_broadcast')) continue;
      out.push({ channel: target.name, author: message.bot_id && !message.user ? 'a bot' : await this.userName(message.user),
        text: (await this.plain(message.text)).slice(0, 1500),
        at: message.ts ? new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '' });
    }
    return out;
  }

  /** A thread Nogita was mentioned in, oldest first, as "Name: text" lines for conversation context. */
  async readThread(channelId: string, threadTs: string, limit = 40): Promise<string[]> {
    const result = await this.call('conversations.replies', { channel: channelId, ts: threadTs, limit: Math.min(limit, 100) });
    const messages = (result.messages as Array<{ user?: string; text?: string; bot_id?: string; subtype?: string }> | undefined) ?? [];
    const lines: string[] = [];
    for (const message of messages.slice(-limit)) {
      if (!message.text || (message.subtype && message.subtype !== 'thread_broadcast')) continue;
      const author = message.bot_id && !message.user ? 'Nogita' : await this.userName(message.user);
      lines.push(`${author}: ${(await this.plain(message.text)).slice(0, 1500)}`);
    }
    return lines;
  }

  async searchMessages(query: string, limit = 15): Promise<ChatMessage[]> {
    if (!this.userToken) throw new Error('Slack search needs SLACK_USER_TOKEN with search:read');
    const result = await this.call('search.messages', { query: query.slice(0, 300), count: Math.min(limit, 30), sort: 'timestamp' }, this.userToken);
    const matches = ((result.messages as { matches?: Array<{ channel?: { name?: string; is_private?: boolean }; username?: string; user?: string; text?: string; ts?: string; permalink?: string }> } | undefined)?.matches) ?? [];
    const member = new Set((await this.listChannels()).map(channel => channel.name));
    const out: ChatMessage[] = [];
    // Only surface messages from channels the bot itself can see, even though the user token sees more.
    for (const match of matches) {
      if (!match.text || !match.channel?.name || !member.has(match.channel.name)) continue;
      out.push({ channel: match.channel.name, author: match.username ?? await this.userName(match.user),
        text: (await this.plain(match.text)).slice(0, 800), url: match.permalink,
        at: match.ts ? new Date(Number(match.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '' });
    }
    return out;
  }

  async postMessage(channel: string, text: string): Promise<ActionReceipt> {
    const target = await this.resolve(channel);
    const posted = await this.call('chat.postMessage', { channel: target.id, text: text.slice(0, 3000) }, this.botToken, true);
    const ts = typeof posted.ts === 'string' ? posted.ts : '';
    let url = '';
    try {
      const link = await this.call('chat.getPermalink', { channel: target.id, message_ts: ts });
      url = typeof link.permalink === 'string' ? link.permalink : '';
    } catch { /* The post succeeded; a missing permalink is not a failure. */ }
    return { provider: 'slack', kind: 'message', label: `#${target.name}`, url: url || `https://slack.com/app_redirect?channel=${target.id}` };
  }
}
