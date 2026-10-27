# Security and privacy: non-negotiable V1 gates

**This repository is a development starter. Do not expose the local server to a public URL or use it in a sensitive team meeting yet.**

## Present safety controls

- Signed Slack Events verification: HMAC SHA256 and 5-minute timestamp window.
- Signed Attendee webhook verification using the provider's canonical JSON and project HMAC secret.
- Admin-token protection for development ingestion and session administration.
- Code read and board mutation gated by verified actor ID + explicit configured allowlist.
- User requests must directly address Nogita by name before any spoken answer or task execution.
- Regex second gate prevents unrequested model-proposed task creation.
- GitHub repository is fixed by configuration; no model-selected arbitrary endpoint or token scope.
- Jira Cloud domain is allowlisted; Recall meeting URL has an explicit host allowlist.
- No persistent meeting transcript or recording in app code; bounded in-memory buffer cleared on leave.
- Draft PR deliberately rejected until a trusted isolated code runner and policy exist.
- API secret strings are environment variables and never written into demo output.
- The authenticated readiness report exposes only fixed status messages; it never returns configured values, identifiers, URLs, or secrets.

## Known blockers before real teams use it

1. **Authenticating meeting participants:** Attendee stable user UUIDs can be enrolled into the shared identity directory, but the workspace's identity provenance and enrollment procedure still require live validation. Self-asserted names are never trusted.
2. **Audience-level authorization:** a verified questioner may still be in a meeting with unauthorized listeners. Sensitive GitHub/Jira answers must account for all attendees.
3. **Real-time media disclosure and provider data retention:** verify actual Recall, speech provider and AI processor settings, consent requirements, regional storage and logs.
4. **Persistent idempotency:** Attendee and Slack persist only hashed delivery IDs (plus hashed Attendee bot/session bindings) with bounded retention, suppressing completed replays and allowing Attendee restart restoration. Delivery is still at-least-once across the crash window between an external effect and ledger completion. Slack acknowledges before slow processing, so unfinished-job recovery and external-write reconciliation still require an encrypted durable queue before production.
5. **Real-time media:** Attendee signed transcript ingestion and provider TTS are implemented; direct realtime audio streaming is not. Recall still joins/sends chat only.
6. **Raise-hand limitation:** no native Recall raise-hand API was confirmed. No fallback chat or speech to violate product rules.
7. **Work completion jobs:** a durable queue and cancellation semantics are required for long-running operations and tool errors.
8. **Slack resilience:** incoming events are acked before background work completes, with no durable queue and no verified Slack workspace OAuth installation.
9. **monday.com mapping:** item description now requires an explicitly mapped Text column; assignee mapping is still absent.
10. **Jira specifics:** issue types/required fields vary per project; check create metadata. Generic v3 payload is not a guarantee for every Jira board.
11. **Prompt injection:** retrieved code and documents are marked untrusted, but live defensive tests, more robust schema validation and tool result boundary rules are still necessary.
12. **Project secrecy:** logs must avoid API response bodies, PII, meeting URLs (which may contain join secrets) and raw transcripts.
13. **Privacy lifecycle:** cleanup is memory-only; include temporary network buffers, crash handling and all subprocess/provider retention before claiming ZDR.
14. **DDoS / replay / abuse:** add rate limits, durable replay ledger, quotas, outbound API circuit breakers and request tracing with redaction.

## Recommended staging procedure

- Begin with a disposable company test workspace and deliberately non-sensitive demo code.
- Rotate all tokens after testing. Use fine-grained scopes and store production credentials in a proper secret manager.
- Keep writes restricted to sandbox boards until end-to-end security acceptance passes.
- Require a human to review every draft PR, never auto-merge or auto-deploy.
- Audit provider SDK/API changes regularly; documentation links in README point to official provider docs.
