# Graceful Slack work draining

## Goal

Reduce the common KAN-11 loss window during normal deployments without persisting Slack message content.

## Design

- Track every accepted asynchronous Slack job in memory.
- On `SIGTERM` or `SIGINT`, stop the HTTP server or disconnect Socket Mode before draining.
- Wait up to 30 seconds for work accepted before shutdown.
- Observe both successful and failed promises so draining cannot produce an unhandled rejection.
- Make the tracker reject new work after draining begins.
- Set a failing process exit code and emit a metadata-only error if the bounded drain times out.

## Scope boundary

This is deployment-loss reduction, not a durable queue. A hard crash after acknowledgement can still lose the message. No Slack text, user ID, channel ID, team ID, or credential is written to disk.
