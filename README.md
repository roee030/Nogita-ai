# Nogita-ai

An extensible virtual engineering teammate for real-time meetings, project knowledge, and authorized task execution.

> **Status: development foundation, NOT a completed voice agent or production app.** The bundled demo and 17 automated tests pass using Node 22.16. No external account or provider API was called during validation. See [Status](#verified-status).

## Your exact interaction rules

1. **Nogita speaks only after a direct address by name**, such as `Nogita, how does auth work?`. Follow-up questions without its name do **not** activate speech.
2. When Nogita detects something significant without being addressed, it may **raise a hand** if the platform supports it. It never speaks or creates a task merely because it raised a hand. Someone must then address it by name to hear its contribution.
3. **After an explicitly requested task completes, Nogita sends the result/link in the meeting chat.** No unrequested completion speech.
4. No autonomous Jira/Monday writes, draft PRs, merging, deployments, or background task execution. Draft PR workflow is **deliberately disabled** in this starter.
5. Meetings are **invitation only**. Meeting context exists in memory for the session and is purged on session end. Live media privacy requires provider-level verification before deployment.
6. English only for speech and language reasoning.

## Fast local demo (no credentials needed)

Requires **Node.js >=22.16.0**.

```bash
cd nogita-v1-starter
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

## Provider configuration (incrementally)

The `.env.example` file documents environment variables. Never commit real secrets or expose the development API publicly.

| Provider | Supported in this starter | Still missing |
| --- | --- | --- |
| Demo meeting / board / repo | Fully executable local simulation | N/A |
| Jira Cloud | REST v3 create issue, ADF description, optional allowlisted account ID | Dynamic create metadata, user lookup, robust idempotency, integration account tests |
| GitHub | Read repository tree and relevant source files with fine-grained token | Semantic search/index, branch/PR creation, access checks for whole meeting audience |
| monday.com | GraphQL item creation (title + required configured description Text column) | Column discovery, assignee mapping, robust error reconciliation |
| Slack | Signed Events API ingestion (mentions) and thread replies with bot token | OAuth installation, per-user authorization, realtime contextual search, durable event queue |
| Recall | Create a bot with approved Meet/Zoom/Teams URL, send receipt to meeting chat, remove bot | **Real-time audio input/output and authenticated event ingestion**, raise-hand bridge, live validation |
| Anthropic | Optional live Messages API text planner and source-grounded summary | Voice pipeline, streaming, latency tuning |
| Teams messaging | Port planned | Adapter/permissions implementation |
| Zoom/Meet | Meeting URL routed through Recall bot | Native voice + platform-specific raise hand |

### Enabling live components

- For Jira set `BOARD_PROVIDER=jira` and populate Jira Cloud variables. Task creation mutates the configured Jira project; test with a dedicated sandbox project and least-privilege account.
- For monday.com set `BOARD_PROVIDER=monday` and corresponding token/board. Configure `MONDAY_DESCRIPTION_COLUMN_ID` with a verified Text column on the board. The adapter refuses to silently discard the task description. Assignee mapping and arbitrary custom fields still require development.
- For GitHub set `REPO_PROVIDER=github` and a read-only fine-grained PAT restricted to a test repository.
- For Anthropic set `NOGITA_MODE=live` plus `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. The text planner is functional against the documented API shape but has not been exercised with real credentials.
- For a Recall join/chat API integration set `MEETING_PROVIDER=recall` and `RECALL_API_KEY`, and provide an allowed `meetingUrl` when creating a session. **Do not attempt a voice demo yet.** `speak()` intentionally rejects so we cannot misrepresent missing functionality.
- For shared identities, set `IDENTITY_MAP_JSON` in local `.env` from `config/identities.example.json`, then authorize internal IDs such as `roee` in `AUTHORIZED_ACTOR_IDS`. Provider identifiers are never guessed; unknown users remain unauthorized.
- For Slack configure a signed Events subscription to `POST /slack/events`, supply `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`, and include Slack user IDs in the allowlist to enable sensitive actions. Use a properly configured HTTPS endpoint and a durable queue before production.

### Provisioning test identities

The repository includes `qa-user` and `developer-user` records in `config/identities.example.json`. Each external service still requires a real test account: invite the account to the Slack workspace, add it to the Jira site/project, and create or select its GitHub account. Copy the provider-issued Slack User ID, Jira Account ID, and GitHub username into the matching local `.env` record while keeping the same internal `id`. Never invent provider IDs, and do not commit the populated identity map.

The shared internal ID is Nogita's stable identity key; Slack, Jira, and GitHub keep their own unrelated IDs. Only internal IDs listed in `AUTHORIZED_ACTOR_IDS` may read repository evidence or create Jira tasks.

## Verified status

- `npm test`: **31 passing tests** for activation behavior, identity mapping, non-interruption, permissions, request guards, Slack verification and Socket Mode, Jira/Monday/GitHub/Recall/Attendee HTTP contracts, and session cleanup.
- `npm run demo`: **passes**; demonstrates inactive listening, code lookup, raising a hand without speaking, then authorized task creation and a chat receipt.
- Live Jira, GitHub, and Slack credentials have been validated in the dedicated test environment; voice media remains unverified.
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

The HTTP server now supports `MEETING_PROVIDER=attendee` alongside `demo` and `recall`.
The Attendee adapter supports meeting join, provider TTS speech requests, completion-chat messages, and leave using its REST API. **It does not yet ingest live audio**, verify who spoke, or implement native raise-hand. Never expose the development utterance endpoint to meeting participants or the internet.

Before testing with a real meeting: review Attendee's audio/recording/retention policy, set `ATTENDEE_PRIVACY_REVIEWED=true` only after that review, and provide `ATTENDEE_API_KEY` securely. An API key is not needed for local mocks. Attendee remains an evaluation candidate; endpoint behavior must be tested against a real account. Docs: https://docs.attendee.dev/api-reference/tag/bots

## Quick Slack test (no public webhook needed)

1. Create a Slack app (from scratch), enable **Socket Mode**, then generate an app-level token with `connections:write` (starts with `xapp-`).
2. Set bot token scopes `app_mentions:read`, `chat:write`, and `im:history`, subscribe to bot events `app_mention` and `message.im`, and **Install to Workspace** to obtain a bot token (`xoxb-`). Reinstall after scope changes.
3. In local `.env`, set `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_ALLOWED_TEAM_IDS=T012...`, `SLACK_BOT_USER_ID=U012...`, `IDENTITY_MAP_JSON` with the matching Slack identity, and `AUTHORIZED_ACTOR_IDS` with its internal ID. For a no-cost echo test keep `NOGITA_MODE=demo` and providers `demo`; answers and task links are simulated.
4. Run `npm install` and `npm run slack`, invite the app to a test channel (`/invite @Nogita`), then say `@Nogita hello` or send it a DM saying `Nogita, hello`. The reply stays in the originating thread. DMs without an explicit name are ignored.

`MEETING_PROVIDER=attendee` is independent of the Slack bot: Slack channel messages are **not** Zoom/Meet/Teams calls. Real spoken meetings still require verified audio ingestion and a live identity bridge. Keep `.env` local and never paste tokens into chat or commit them. Note: Socket Mode is for local prototyping, not Slack Marketplace distribution.
