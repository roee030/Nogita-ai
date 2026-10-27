# Jira Crash-Safe Idempotency Design

## Intent

Prevent an explicitly requested Jira task from being created twice when Nogita crashes or restarts after Jira accepted the issue but before the surrounding event ledger records completion.

## Goals

- Reuse the Jira issue created for the same trusted `CreateTask.requestId` across retries and process restarts.
- Persist only a one-way SHA-256 digest of the request ID in Jira.
- Keep transcripts, participant identifiers, provider delivery IDs, credentials, and raw internal request IDs out of Jira.
- Fail closed when the recovery lookup cannot be trusted; do not create a possibly duplicate issue.

## Non-goals

- Global exactly-once guarantees across multiple simultaneously active Nogita deployments.
- A general durable queue for every Slack or Attendee side effect.
- Monday.com idempotency; Jira is the selected product board.
- Changing user-visible issue summaries, descriptions, labels, or workflow.

## Constraints

- Use Jira Cloud REST API v3 and the existing Basic authentication.
- No new dependencies or infrastructure.
- Preserve the current `BoardPort` and `CreateTask` interfaces.
- Continue returning only Jira issue keys and browse URLs as receipts.

## Approaches considered

1. **Local receipt file only.** Simple and private, but Render's free filesystem is ephemeral and cannot recover across replacement deployments. Rejected as the primary guarantee.
2. **Visible Jira label containing a digest.** Searchable and durable, but pollutes the board and depends on the Labels field being available. Rejected.
3. **Jira issue property containing a digest, recovered by scanning recent Nogita-created issues.** Durable, invisible in the normal board, supported by Jira's create/search payloads, and stores no raw identifier. Chosen.

## Design

For each create request, compute SHA-256 over a versioned namespace plus `requestId`. Store `{ "digest": "<64 lowercase hex>" }` under the issue property key `com.nogita.request.v1` in the same create request as the issue.

Before creating, call Jira enhanced JQL search for the configured project, limited to issues created by the authenticated Jira user and ordered newest first. Request only `key` plus `com.nogita.request.v1`, with a bounded result count of 100. If exactly one returned issue has the matching digest, return its normal action receipt without creating. If more than one matches, return the newest matching key and avoid another write. If the search fails, returns malformed data, or returns an invalid matching key, throw a safe status-only error and do not create.

The search window deliberately bounds work and data exposure. It protects the realistic retry/restart interval but is not a multi-deployment uniqueness constraint. The existing event ledger remains the concurrent-delivery guard for the active deployment.

## Security and privacy

- The digest is domain-separated and cannot reveal the request ID.
- The raw request ID is never placed in a URL, JQL string, issue field, property, or log.
- Search and create errors expose only HTTP status codes.
- Jira credentials remain only in request headers sourced from environment configuration.

## Verification

- A first request performs recovery lookup, then creates an issue with the hashed property.
- A retry with the same request ID returns the existing issue without a create call.
- Serialized Jira request data never contains the raw request ID.
- A failed or malformed recovery lookup prevents creation.
- Full tests and TypeScript typecheck remain green.
