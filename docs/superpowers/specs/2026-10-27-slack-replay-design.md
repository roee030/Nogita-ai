# Slack Replay Suppression Design

## Intent

Replace process-memory Slack replay sets with the existing privacy-safe file ledger so completed Slack deliveries stay suppressed across service restarts.

## Scope

- Cover both Socket Mode and the signed HTTP Events API.
- Persist only SHA-256-derived empty marker files with bounded retention.
- Complete a marker only after event processing succeeds; release it on failure.
- Preserve prompt acknowledgement behavior for Socket Mode and prompt HTTP responses.
- Never persist Slack message text, channel/user/team IDs, tokens, or credentials.

## Non-goals

- This slice does not durably store unfinished Slack work. A crash after Slack acknowledgement can still lose an in-flight event.
- This slice does not provide exactly-once external effects. KAN-11 remains open for an encrypted recoverable queue and effect reconciliation.

## Approach

Reuse `FileEventLedger` with a `slack` namespace in both entry points. This avoids a second persistence design and keeps retention/privacy behavior consistent with Attendee. An encrypted payload queue was considered but deferred because it requires key lifecycle, recovery-worker, and data-retention decisions beyond this bounded task. Keeping the in-memory sets was rejected because it loses replay history on every restart.
