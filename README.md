# Nogita-ai

An extensible virtual engineering teammate for real-time meetings, project knowledge, and authorized task execution.

> **Status: development foundation, NOT a completed voice agent or production app.** The bundled demo and automated tests pass on Node 22.16 or newer. See [Status](#verified-status) for the integrations that have been live-validated.

## Your exact interaction rules

1. **Nogita speaks only after a direct address by name**, such as `Nogita, how does auth work?`. The one exception: when Nogita has just asked the same speaker a question (for example "Which Moshe, Cohen or Levi?"), that speaker's reply within 60 seconds reaches her without the name; if the reply is not meant for her she stays silent.
2. When Nogita detects something critical without being addressed (security or privacy risk, data loss, a contradiction, a factual mistake), it may **raise a hand**. It never speaks or creates a task merely because it raised a hand. Someone must then address it by name ("Nogita, go ahead") to hear its contribution. Where the platform has no native hand raise, `NOGITA_HAND_RAISE_FALLBACK=chat` posts one short chat line instead.
3. **After an explicitly requested task or message completes, Nogita sends the result/link in the meeting chat.** No unrequested completion speech.
4. No autonomous Jira/Monday writes, Slack posts, draft PRs, merging, deployments, or background task execution. Writes happen only on an explicit request from an authorized speaker. Draft PR workflow is **deliberately disabled** in this starter.
5. Meetings are **invitation only**. Meeting context exists in memory for the session and is purged on session end. Live media privacy requires provider-level verification before deployment.
6. English only for speech and language reasoning.

## Fast local demo (no credentials needed)

Requires **Node.js >=22.16.0**.

The repository pins `22.16.0` in `.node-version`. Use a Node version manager that honors this file, or install any newer supported release before running the commands. Pull requests and pushes to `main` run the same tests and type checks in GitHub Actions with read-only repository permissions.

```bash
npm run demo
npm test
```

The demo uses simulated meetings, a simulated code repository and simulated task board. URLs ending in `example.invalid` are **intentionally fake**; nothing is pushed to external systems.

## Development HTTP server

1. Copy `.env.example` to `.env`.
2. Replace `NOGITA_ADMIN_TOKEN` with a random, long secret (at least 20 characters).
3. Keep `HOST=127.0.0.1`, `NOGITA_MODE=demo` initially.
4. Run `npm start`.

A sample request to create a **demo-only** session:

```bash
curl -X POST http://127.0.0.1:8787/api/sessions \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"id":"demo-meeting", "provider":"demo"}'
```

Inject a **test utterance** (this is not a live microphone/audio connection):

```bash
curl -X POST http://127.0.0.1:8787/api/utterances \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo-meeting","utterance":{"eventId":"u-1","actor":{"id":"demo-lead","displayName":"Lead","verified":true},"text":"Nogita, create a task to review the authentication flow"}}'
```

This endpoint returns demo `speak` and `chat` events. The endpoint trusts the bearer token holder and is for local development only; it is **not** a production meeting webhook.

Stop the session by issuing `DELETE /api/sessions/demo-meeting` with the bearer token.

Check product configuration without exposing any secret values:

```bash
curl http://127.0.0.1:8787/api/readiness \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN'
```

The protected endpoint returns fixed `ready`/`blocked` checks for the runtime, admin authentication, Slack, Jira, GitHub, Attendee, and live reasoning. It returns HTTP 503 while a blocker remains, which makes it suitable for deployment readiness probes without turning `/health` into a secrets/configuration inventory.

## Conversational agent (live mode)

In live mode every direct request is answered by a tool-using Claude agent (`src/core/agent.ts`, default model
`claude-sonnet-5-5`), not by a fixed plan. It decides what to look up, can run several lookups in parallel, and
answers in its own words:

| Source | Tools |
| --- | --- |
| GitHub | `search_code`, `read_file` (numbered lines, pinned links), `list_files`, `recent_commits` |
| Jira | `search_tasks` (text or JQL, always inside the configured projects), `get_task`, `create_task` with the owner resolved by name |
| Slack | `list_channels`, `read_channel`, `search_messages` (with a user token), `post_message` |

How it stays fast and natural in a voice meeting:

- The answer is **streamed**: the first sentence goes to speech as soon as it exists, later sentences in small batches.
- Before a lookup Nogita says one short lead-in ("Let me check the retry worker.") instead of a canned filler; after
  six seconds of silence she says one "still on it".
- The repository map and README are in the system prompt, which is **prompt-cached** together with the tool list,
  and an in-memory code search runs before the first model call, so most questions need one lookup round.
- Spoken answers stay short (about 90 words, no markdown); the full answer goes to meeting chat once, with a code link.

Safety stays outside the model: tools are only offered to authorized speakers, every write is checked against the
explicit request (`requestsTaskWrite` / `requestsChatPost`), owners are resolved only through the identity map or
Jira's own assignable-user search (ambiguous names make Nogita ask), and task creation keeps its idempotency key.
In a Slack thread the agent reads the whole thread as context; a DM is addressed to Nogita without her name.

Measured on 2026-10-28 against this repository, its Jira board and the live API (`tools/agent-smoke.ts`, read-only,
five questions, speech provider excluded): first spoken text 1.1–2.3 s, complete answer 2.9–6.8 s, about $0.02 per
question with Sonnet. Run it yourself:

```bash
node --experimental-transform-types tools/agent-smoke.ts "Nogita, how does the Jira idempotency work?"
```

`NOGITA_AGENT=off` returns to the one-shot planner.

## Voice lab

`npm run voice-lab` tests Nogita by voice without a meeting. Synthetic colleagues ask spoken questions:
- with office, cafe, keyboard or street noise;
- mid-sentence pauses, interruptions and trick questions;
- through the production audio path: Attendee audio hub, Deepgram, router, engine and agent.

It reports the silence between each question and Nogita's first sound, broken down by stage, and checks what she said and did. Writes are intercepted. See [docs/VOICE_LAB.md](docs/VOICE_LAB.md).

## Provider configuration (incrementally)

The `.env.example` file documents environment variables. Never commit real secrets or expose the development API publicly.

| Provider | Supported in this starter | Still missing |
| --- | --- | --- |
| Demo meeting / board / repo | Fully executable local simulation | N/A |
| Jira Cloud | REST v3 create issue with crash-safe idempotency, search (text/JQL) and read issues, owner by name (identity map or assignable-user search) | Dynamic create metadata, custom fields, issue updates |
| GitHub | Pinned in-memory index: keyword search, whole-file reads, file listing, recent commits | Semantic/vector search, branch/PR creation, access checks for whole meeting audience |
| monday.com | GraphQL item creation (title + required configured description Text column) | Column discovery, assignee mapping, robust error reconciliation |
| Slack | Signed Events API and Socket Mode ingestion, encrypted retry queue, mentions, DMs and thread replies; agent reads channels/threads, searches (user token) and posts on request | Queue persistence across instance replacement without a persistent disk; Marketplace OAuth distribution |
| Recall | Create a bot with approved Meet/Zoom/Teams URL, send receipt to meeting chat, remove bot | **Real-time audio input/output and authenticated event ingestion**, raise-hand bridge, live validation |
| Attendee | Join, provider TTS with chat fallback, encrypted retry queue, signed transcript events, session-scoped speaker verification, provider-ended/idle cleanup | Queue persistence across instance replacement without a persistent disk; native raise hand and final live validation of the updated flow |
| Anthropic | Streaming tool-use agent with prompt caching (default), one-shot planner fallback, background hand-raise assessor | Talker/reasoner split for sub-second first words |
| Teams messaging | Port planned | Adapter/permissions implementation |
| Zoom/Meet | Meeting URL routed through Recall bot | Native voice + platform-specific raise hand |

### Enabling live components

- For Jira set `BOARD_PROVIDER=jira` and populate Jira Cloud variables. Task creation mutates the configured Jira project; test with a dedicated sandbox project and least-privilege account.
- For monday.com set `BOARD_PROVIDER=monday` and corresponding token/board. Configure `MONDAY_DESCRIPTION_COLUMN_ID` with a verified Text column on the board. The adapter refuses to silently discard the task description. Assignee mapping and arbitrary custom fields still require development.
- For a public GitHub repository set `REPO_PROVIDER=github`, `GITHUB_PUBLIC_REPO=true`, and leave `GITHUB_TOKEN` empty; source lookup then resolves the Git ref through Git's read-only HTTP protocol and fetches a commit-pinned source archive without using GitHub's API quota. Recent-commit questions still use GitHub's API and can be rate-limited. Private repositories require a read-only fine-grained PAT restricted to that repository. Source files above 1 MiB are skipped and reported as incomplete coverage when a search finds no evidence; credential filtering is best effort, not a guarantee that arbitrary hardcoded secrets are safe to index.
- For Anthropic set `NOGITA_MODE=live` plus `ANTHROPIC_API_KEY`. `ANTHROPIC_MODEL` is an optional override; the maintained default is `claude-haiku-5-5`, selected for low latency and cost in live conversation. The text planner is functional against the documented API shape but has not been exercised with real credentials. Creating a provider account, purchasing credits, and adding the key remain explicit operator actions; never commit the key.
- For a Recall join/chat API integration set `MEETING_PROVIDER=recall` and `RECALL_API_KEY`, and provide an allowed `meetingUrl` when creating a session. **Do not attempt a voice demo yet.** `speak()` intentionally rejects so we cannot misrepresent missing functionality.
- For shared identities, set `IDENTITY_MAP_JSON` in local `.env` from `config/identities.example.json`, then authorize internal IDs such as `roee` in `AUTHORIZED_ACTOR_IDS`. Provider identifiers are never guessed; unknown users remain unauthorized.
- For Slack, the HTTP service can receive a signed Events API subscription at `POST /slack/events`, or it starts a Socket Mode consumer when valid `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` values are present. Readiness reports Socket Mode ready only after the websocket connects. Include Slack user IDs in the allowlist to enable sensitive actions. For reliable production delivery, prefer signed Events API; avoid running the local Socket Mode command at the same time as the deployed consumer because the two processes do not share replay state.

### Provisioning test identities

The repository includes `qa-user` and `developer-user` records in `config/identities.example.json`. Each external service still requires a real test account: invite the account to the Slack workspace, add it to the Jira site/project, and create or select its GitHub account. Copy the provider-issued Slack User ID, Jira Account ID, and GitHub username into the matching local `.env` record while keeping the same internal `id`. Never invent provider IDs, and do not commit the populated identity map.

The shared internal ID is Nogita's stable identity key; Slack, Jira, GitHub, and Attendee keep their own unrelated IDs. Only internal IDs listed in `AUTHORIZED_ACTOR_IDS` may read repository evidence or create Jira tasks.

### Attendee live transcript loop

1. Deploy `npm start` behind a stable HTTPS endpoint; do not expose the development server directly from a laptop.
2. Set `ATTENDEE_WEBHOOK_URL=https://your-service.example/webhooks/attendee` and the base64 project secret in `ATTENDEE_WEBHOOK_SECRET`.
3. Set `ATTENDEE_PRIVACY_REVIEWED=true` only after confirming recording, transcription, consent, and retention settings for the workspace.
4. Put the operator's internal identity in local `IDENTITY_MAP_JSON` and `AUTHORIZED_ACTOR_IDS`. A durable `attendeeUserUuid` mapping is optional: when Google Meet does not expose one reliably, the safer meeting-scoped verification flow below is used. Display names are never accepted as identity proof.
5. Start a session through the admin-authenticated `POST /api/sessions` and name that internal owner: `{"id":"meet-2026-10-27","provider":"attendee","meetingUrl":"https://meet.google.com/…","ownerActorId":"roee"}`. Nogita posts a random phrase such as `Nogita verify 482731` in the meeting chat. The owner says that exact phrase once; only that meeting speaker is then bound to the authorized identity, and the binding disappears when the session ends.
6. Signed transcript fragments from the same speaker are combined after 1.2 seconds of quiet before the direct-address policy runs. Different speakers are never combined. Because Attendee cannot prove that queued audio was audible to participants, Nogita posts the answer or action acknowledgement to meeting chat immediately and then attempts speech; an audio failure never duplicates the chat fallback. Actual voice requires a supported TTS credential configured in Attendee; the chat path does not.
7. Attendee is instructed to remove the bot after **180 seconds without speech** or **30 seconds as the only participant**. A provider-ended webhook purges the local session without sending a redundant leave request.

To inspect estimated cost during or after a session, call the admin-authenticated `GET /api/sessions/<session-id>/usage`. It returns meeting duration and transcription mode, Attendee bot-time estimate, Claude model/call/input/output counters, TTS requests/failures, external action counts, and the combined USD estimate without prompts, transcripts, keys, or participant identifiers. `ATTENDEE_USD_PER_HOUR`, `ANTHROPIC_INPUT_USD_PER_MILLION`, and `ANTHROPIC_OUTPUT_USD_PER_MILLION` have documented defaults and should be changed for contracted/current rates. Free-trial credits and final vendor rounding are not observable through this endpoint, so provider invoices remain authoritative.

Before acknowledging accepted Slack or Attendee deliveries, Nogita encrypts the raw provider payload with AES-256-GCM and writes it atomically under `NOGITA_STATE_DIR`. Filenames use keyed hashes rather than raw IDs; leases are exclusive, failed work is retried, completed/dead records are bounded, and successful processing deletes the ciphertext. The separate bounded hash-only ledger suppresses completed replays. Jira task creation also stores a hidden, domain-separated SHA-256 request marker on the issue and scans a bounded set of recent Nogita-created issues before retrying, so a restart after Jira accepted the task reuses the existing issue rather than creating another. This queue is designed for the current single Render instance or multiple processes sharing one filesystem; active/active hosts without shared storage require PostgreSQL or another shared queue.

Generate `NOGITA_QUEUE_ENCRYPTION_KEY` as exactly 32 random bytes encoded with base64 and keep it stable in the local/deployment secret store. Rotating it while queued records exist makes those records unreadable, so drain the queue before rotation. Slack Socket Mode and signed Events API use the same encrypted queue and hash-only replay ledger. On `SIGTERM` or `SIGINT`, both runtimes stop polling and drain accepted work before shutdown.

## Verified status

- `npm test`: covers activation behavior, meeting-scoped verification, ordered split-caption assembly, automatic voice-to-chat fallback, automatic leave settings, complete per-session usage estimates, encrypted-at-rest delivery recovery, exclusive queue claims, tamper rejection, bounded retention, identity mapping, permissions, Jira crash-retry recovery, Slack verification and Socket Mode, live adapter contracts, race-safe startup, and session cleanup.
- `npm run demo`: **passes**; demonstrates inactive listening, code lookup, raising a hand without speaking, then authorized task creation and a chat receipt.
- On 2026-10-28, the live Render service verified GitHub, Jira, Attendee, Slack, and the configured Anthropic model as connected. Readiness now intentionally blocks the Render Free deployment because its filesystem is ephemeral; provider connectivity does not prove end-to-end Slack replies or audible meeting playback.
- `npm run typecheck`: **passes** with the installed dependencies.

## Documentation

- [Product scope & acceptance criteria](docs/PRODUCT_SPEC.md)
- [Provider-neutral architecture](docs/ARCHITECTURE.md)
- [Integration roadmap](docs/INTEGRATION_ROADMAP.md)
- [Security, privacy and production blockers](docs/SECURITY.md)

## Useful API docs

- [Recall Create Bot](https://docs.recall.ai/reference/bot_create)
- [Recall Output Media](https://docs.recall.ai/docs/stream-media)
- [Recall Send Chat Message](https://docs.recall.ai/reference/bot_send_chat_message_create)
- [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Jira Cloud v3 create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [monday.com GraphQL](https://developer.monday.com/api-reference/docs/basics)
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)

## Alternative meeting provider — Attendee.dev

The HTTP server supports `MEETING_PROVIDER=attendee` alongside `demo` and `recall`. Its default remains signed captions plus the existing speech output. An experimental, disabled-by-default realtime path can instead receive per-participant PCM from Attendee, send each speaker stream to Deepgram Nova-3 multilingual, and stream English Aura-2 speech back through Attendee. Completed turns still pass through the same meeting-scoped speaker verification, Nogita engine, policy, and chat-mirror fallback. It does not implement native raise-hand or prove that submitted audio was audible to participants.

To evaluate realtime audio, first deploy the service behind stable HTTPS with WSS support and review the recording/transcription consent and retention settings for every relevant provider. Only then set `NOGITA_REALTIME_AUDIO_ENABLED=true`, `ATTENDEE_AUDIO_WEBSOCKET_URL=wss://<host>/webhooks/attendee/audio`, and `DEEPGRAM_API_KEY` in the server's secret store. The app remains disabled by default; do not enable the flag until the privacy review and a test meeting are explicitly scheduled. Incoming audio is not written to disk or logged, but it is sent to Deepgram for transcription. `DEEPGRAM_STT_MODE=nova3-multilingual` is the default, including Hebrew recognition; `flux-english` is an opt-in English turn-detector experiment. `DEEPGRAM_TTS_MODEL` selects a validated English Aura-2 voice (default `aura-2-thalia-en`) for a consented listening comparison. Hebrew speech output is not supported by this TTS path. Unknown speakers remain unverified; participant names never establish identity.

For public GitHub repositories without a token, code questions use a revision-pinned source archive and a five-minute in-memory index instead of one anonymous API request per file. GitHub's unauthenticated API limit still applies to resolving the latest commit; the index may lag a recent push by up to five minutes. The archive is bounded and excludes credential-like paths, generated output, and non-source file extensions. Private repositories require a read-only GitHub token kept in the deployment secret store, never in Git or meeting chat.

`GET /api/sessions/<session-id>/usage` reports estimated Deepgram cost separately from Attendee meeting time and Claude usage. The starting assumptions are Nova-3 multilingual streaming at `$0.0058/minute` and Aura-2 at `$0.03/1,000 characters` (pay-as-you-go rates observed on 2026-10-28); set `DEEPGRAM_NOVA3_MULTILINGUAL_USD_PER_MINUTE` and `DEEPGRAM_AURA2_USD_PER_THOUSAND_CHARACTERS` to current contracted prices. STT estimates use submitted 16 kHz PCM duration and TTS estimates use submitted character counts; provider invoices remain authoritative and may differ due to account plan, silence handling, or billing rules.

Before testing with a real meeting: deploy the webhook behind stable HTTPS, review Attendee's audio/recording/retention policy, set `ATTENDEE_PRIVACY_REVIEWED=true` only after that review, configure the authorized internal owner, and provide credentials securely. An API key is not needed for local mocks. Attendee remains an evaluation candidate until the updated flow is validated in a real meeting. Docs: https://docs.attendee.dev/api-reference/tag/bots

## Quick Slack test (no public webhook needed)

1. Create a Slack app (from scratch), enable **Socket Mode**, then generate an app-level token with `connections:write` (starts with `xapp-`).
2. Set bot token scopes `app_mentions:read`, `chat:write`, and `im:history`, subscribe to bot events `app_mention` and `message.im`, and **Install to Workspace** to obtain a bot token (`xoxb-`). Reinstall after scope changes.
3. In local `.env`, set `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_ALLOWED_TEAM_IDS=T012...`, `SLACK_BOT_USER_ID=U012...`, `IDENTITY_MAP_JSON` with the matching Slack identity, and `AUTHORIZED_ACTOR_IDS` with its internal ID. For a no-cost echo test keep `NOGITA_MODE=demo` and providers `demo`; answers and task links are simulated.
4. Run `npm install` and `npm run slack`, invite the app to a test channel (`/invite @Nogita`), then say `@Nogita hello` or send it a DM saying `Nogita, hello`. The reply stays in the originating thread. DMs without an explicit name are ignored.

`MEETING_PROVIDER=attendee` is independent of the Slack bot: Slack channel messages are **not** Zoom/Meet/Teams calls. A real spoken-meeting test still requires stable HTTPS, privacy acceptance, an authorized internal owner, and live provider validation; a durable Attendee speaker UUID is optional. Keep `.env` local and never paste tokens into chat or commit them. Slack Socket Mode is not allowed for public Marketplace distribution.

### Production container

`Dockerfile` builds the HTTP service on the pinned Node 22.16 runtime with production dependencies only and runs it as the unprivileged `node` user. Inject configuration through the hosting platform's secret store; the image does not contain `.env`, Git metadata, tests, docs, or local runtime state. Mount a persistent volume at `/var/lib/nogita` for the encrypted queue, hash-only replay ledger, and hashed bot bindings. The container exposes port 8787 and includes a `/health` check. CI builds the image on every pull request.

**Current deployment limitation:** the Nogita Render service is on the Free plan, whose filesystem is ephemeral. The encrypted queue can retry work during the running instance's lifetime, but it does not survive instance replacement or redeploy. Therefore cross-redeploy queue durability remains blocked until persistent storage is configured. Readiness blocks on this condition unless `NOGITA_STATE_PERSISTENT=true`; set it only after mounting persistent storage and pointing `NOGITA_STATE_DIR` inside that mount. No paid storage has been provisioned.
