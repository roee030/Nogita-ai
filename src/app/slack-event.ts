import { directlyAddressesNogita } from '../core/policy.ts';
import type { Utterance } from '../core/contracts.ts';
import type { IdentityDirectory } from '../core/identity.ts';

/** Shared by Socket Mode and future HTTP event handling. No untrusted Slack event becomes a verified actor. */
export interface SlackEnvelope {
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    channel_type?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
    text?: string;
    bot_id?: string;
    subtype?: string;
  };
}

export interface SlackRequest {
  sessionId: string;
  channel: string;
  threadTs: string;
  utterance: Utterance;
}

export function parseSlackRequest(
  body: SlackEnvelope,
  allowedTeams: ReadonlySet<string>,
  botUserId?: string,
  identities?: IdentityDirectory,
): SlackRequest | null {
  const e = body.event;
  const team = body.team_id ?? '';
  if (!team || !allowedTeams.has(team) || !e || e.bot_id || e.subtype ||
      !body.event_id || !e.user || !e.channel || !e.ts ||
      !e.text?.trim()) return null;

  const mentioned = e.type === 'app_mention';
  const dm = e.type === 'message' && e.channel_type === 'im';
  if (!mentioned && !dm) return null;

  let text = e.text.trim();
  if (mentioned) {
    // Slack app_mention events refer to this app, but remove only its own mention,
    // retaining references to other people for task ownership resolution.
    if (botUserId) {
      const selfMention = new RegExp('<@' + botUserId.replace(/[^A-Za-z0-9]/g, '') + '(?:\\|[^>]+)?>', 'g');
      text = text.replace(selfMention, '').trim();
    } else {
      text = text.replace(/<@[A-Za-z0-9]+(?:\\|[^>]+)?>/, '').trim();
    }
    // The verified Slack app mention is the explicit equivalent of addressing "Nogita".
    text = 'Nogita, ' + text;
  } else if (!directlyAddressesNogita(text)) {
    // Direct-message channel is not enough to override Nogita's name-only policy.
    return null;
  }
  if (!text.trim()) return null;

  const threadTs = e.thread_ts || e.ts;
  const identity = identities?.fromSlack(team, e.user);
  return {
    sessionId: `slack:${team}:${e.channel}:${threadTs}`,
    channel: e.channel,
    threadTs,
    utterance: {
      eventId: body.event_id,
      actor: identity
        ? { id: identity.id, displayName: identity.displayName, verified: true }
        : { id: `unmapped:slack:${team}:${e.user}`, displayName: `Slack user ${e.user}`, verified: false },
      text,
    },
  };
}
