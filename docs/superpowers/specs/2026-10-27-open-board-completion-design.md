# Open Board Completion Design

## Intent

Finish the remaining meaningful MVP work on the KAN board, deploy it, prove the live path, and reconcile Jira so Done means implemented and verified rather than merely attempted.

## Goals

- Complete KAN-21 and KAN-23 with the already implemented speech fallback, caption assembly, session-scoped identity verification, and replay safety.
- Complete KAN-22 with a privacy-safe session report containing Attendee duration and transcription mode, Claude calls/tokens/cost, TTS attempts/failures, and external action counts.
- Complete KAN-11 for the current single-instance Render architecture with an encrypted, restart-safe file queue, atomic leases, retries, bounded retention, and no plaintext message/transcript persistence.
- Complete KAN-20 by deploying and validating the replacement session-scoped challenge flow; a durable participant UUID is optional and must not be copied to Jira or Git.
- Close KAN-1, KAN-2, and KAN-3 as obsolete empty setup placeholders, with an explanatory Jira comment.

## Non-goals

- Multi-host active/active processing without a shared filesystem. The current deployment is one Render instance; a future scale-out requires PostgreSQL or another shared queue.
- Creating or purchasing a TTS provider account. Missing TTS remains non-blocking because chat fallback is mandatory.
- Persisting plaintext Slack messages, meeting transcripts, participant identifiers, meeting URLs, credentials, or challenge phrases.

## Chosen approach

Use the existing persistent `NOGITA_STATE_DIR` and Node cryptography rather than adding a paid database. Accepted Slack and Attendee payloads are encrypted with AES-256-GCM under a deployment-only key, written atomically, leased by rename, retried after failure, and deleted after successful processing. This is the smallest architecture that closes the hard-crash gap for the current one-instance deployment and remains safe for multiple processes sharing the same volume.

Usage counters stay bounded and in memory: no transcript content is required. Provider prices come from environment configuration with documented defaults. The final operational step pushes the existing feature branch, waits for CI/deployment, exercises the protected readiness and usage endpoints, then comments and transitions Jira issues according to observed evidence.

## Constraints

- Secrets remain only in local/deployment environment configuration.
- Queue files are encrypted before disk write; filenames contain only keyed hashes or random IDs.
- Webhooks acknowledge only after durable enqueue.
- Failed work remains retryable and cannot produce duplicate Jira tasks.
- A Jira issue moves to Done only after its acceptance evidence exists.

## Approaches considered

- PostgreSQL queue: best for active/active deployments, but requires provisioning and operating a new paid/shared service. Deferred until scale-out is requested.
- Plain local JSON queue: simplest, but would create a transcript/message archive and violates privacy requirements.
- Encrypted file queue on the existing persistent volume: selected because it closes restart loss without new infrastructure and matches the current single-instance product.
