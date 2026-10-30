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
- Draft PRs are off by default. When turned on (`GITHUB_DRAFT_PRS=true`) Nogita writes no code: a new branch, one note file and a draft pull request, on an explicit request from an authorized speaker. She never writes to an existing branch, merges or deletes. Running code changes still needs a trusted isolated runner.
- Meeting memory is off by default. `NOGITA_MEETING_MEMORY=decisions` stores only plainly stated decisions and action items (speaker names included) under the state directory, deleted after `NOGITA_MEETING_MEMORY_DAYS`. Tell participants before turning it on.
- API secret strings are environment variables and never written into demo output.
- The authenticated readiness report exposes only fixed status messages; it never returns configured values, identifiers, URLs, or secrets.
- Accepted Slack and Attendee payloads are encrypted with AES-256-GCM before atomic persistence; keyed filenames, exclusive leases, bounded retries/retention, and hash-only completion markers support recovery without plaintext at rest when the backing filesystem persists.
- Meeting-scoped random challenge verification binds an authorized internal owner to one provider speaker without trusting display names or durably storing the challenge/speaker binding.
- Attendee answers and action acknowledgements are mirrored to meeting chat before TTS because an accepted speech request does not prove the audio was audible.

## Known blockers before real teams use it

1. **Authenticating meeting participants:** stable provider UUID enrollment and the replacement session-scoped challenge are implemented, but the updated challenge flow still requires final live validation. Self-asserted names are never trusted.
2. **Audience-level authorization:** a verified questioner may still be in a meeting with unauthorized listeners. Sensitive GitHub/Jira answers must account for all attendees.
3. **Real-time media disclosure and provider data retention:** verify actual Recall, speech provider and AI processor settings, consent requirements, regional storage and logs.
4. **Filesystem durability boundary:** the current Render Free filesystem is ephemeral. Encrypted queue records and replay markers do not survive instance replacement or redeploy, so cross-redeploy recovery remains blocked until a persistent disk or managed queue is configured. Active/active hosts need shared storage. Delivery remains at-least-once; Jira's request marker reconciles its external-write crash window.
5. **Real-time media:** Attendee signed transcript ingestion and provider TTS are implemented; direct realtime audio streaming is not. Recall still joins/sends chat only.
6. **Raise-hand limitation:** no native Recall raise-hand API was confirmed. No fallback chat or speech to violate product rules.
7. **Work completion jobs:** provider deliveries are durable, but arbitrary future long-running code/PR jobs still need cancellation semantics and a shared job queue before enablement.
8. **Slack distribution:** Socket Mode and signed Events API delivery are durable; Marketplace OAuth installation and per-workspace lifecycle are not implemented.
9. **monday.com mapping:** item description now requires an explicitly mapped Text column; assignee mapping is still absent.
10. **Jira specifics:** issue types/required fields vary per project; check create metadata. Generic v3 payload is not a guarantee for every Jira board.
11. **Prompt injection:** retrieved code and documents are marked untrusted, but live defensive tests, more robust schema validation and tool result boundary rules are still necessary.
12. **Project secrecy:** logs must avoid API response bodies, PII, meeting URLs (which may contain join secrets) and raw transcripts.
13. **Privacy lifecycle:** queued payloads are encrypted and deleted after success, but provider-side, temporary network, dead-letter, backup, and key-retirement policies must be included before claiming ZDR.
14. **DDoS / replay / abuse:** add rate limits, durable replay ledger, quotas, outbound API circuit breakers and request tracing with redaction.

## Recommended staging procedure

- Begin with a disposable company test workspace and deliberately non-sensitive demo code.
- Rotate all tokens after testing. Use fine-grained scopes and store production credentials in a proper secret manager.
- Keep writes restricted to sandbox boards until end-to-end security acceptance passes.
- Require a human to review every draft PR, never auto-merge or auto-deploy.
- Audit provider SDK/API changes regularly; documentation links in README point to official provider docs.
