export const SLACK_EVENT_TYPES = ['app_mention', 'message'] as const;

export function registerSlackEventHandlers<T>(
  client: { on(event: string, handler: (payload: T) => unknown): unknown },
  handler: (payload: T) => unknown,
): void {
  for (const event of SLACK_EVENT_TYPES) client.on(event, handler);
}
