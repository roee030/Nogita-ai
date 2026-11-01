import type { Utterance } from '../core/contracts.ts';
import type { SlackMissionHandoffs } from './slack-conversations.ts';

export const SLACK_EVENT_TYPES = ['app_mention', 'message'] as const;

export interface SlackMissionReply {
  sessionId: string;
  utterance: Utterance;
}

/** Claims only replies in a thread explicitly bound to a mission; all other Slack traffic remains untouched. */
export async function dispatchSlackMissionReply(
  request: SlackMissionReply,
  handoffs: SlackMissionHandoffs,
  handle: (missionId: string, utterance: Utterance) => Promise<void> | void,
): Promise<boolean> {
  if (!request.utterance.actor.verified) return false;
  const missionId = handoffs.missionForThread(request.sessionId);
  if (!missionId) return false;
  await handle(missionId, request.utterance);
  return true;
}

export function registerSlackEventHandlers<T>(
  client: { on(event: string, handler: (payload: T) => unknown): unknown },
  handler: (payload: T) => unknown,
): void {
  for (const event of SLACK_EVENT_TYPES) client.on(event, handler);
}
