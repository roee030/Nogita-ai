import type { Utterance } from '../core/contracts.ts';
import type { SlackMissionHandoffs } from './slack-conversations.ts';

export const SLACK_EVENT_TYPES = ['app_mention', 'message'] as const;

export function isMissionDecision(text: string): boolean {
  return /\b(?:approve|approved|decline|reject|resume|continue mission|cancel|stop mission)\b/i.test(text);
}

export interface SlackMissionReply {
  sessionId: string;
  utterance: Utterance;
}

interface HandoffMission {
  id: string;
  owner: { id: string };
  sessionId?: string;
}

/** An owner opts a meeting mission into this Slack thread by naming its ID. */
export function missionHandoffRequested(
  text: string,
  actor: { id: string; verified: boolean },
  getMission: (id: string) => HandoffMission | undefined,
): string | undefined {
  if (!actor.verified) return undefined;
  const id = text.toUpperCase().match(/\bM-[A-Z0-9]{1,20}\b/)?.[0];
  if (!id) return undefined;
  const mission = getMission(id);
  return mission?.owner.id === actor.id && Boolean(mission.sessionId) && !mission.sessionId!.startsWith('slack:') ? id : undefined;
}

export async function bindSlackMissionHandoff(
  request: SlackMissionReply & { channel: string; threadTs: string },
  handoffs: SlackMissionHandoffs,
  getMission: (id: string) => HandoffMission | undefined,
): Promise<string | undefined> {
  const missionId = missionHandoffRequested(request.utterance.text, request.utterance.actor, getMission);
  if (!missionId) return undefined;
  const mission = getMission(missionId)!;
  const bound = await handoffs.bind({ missionId, meetingSessionId: mission.sessionId!, slackSessionId: request.sessionId,
    channel: request.channel, threadTs: request.threadTs });
  return bound ? missionId : undefined;
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
