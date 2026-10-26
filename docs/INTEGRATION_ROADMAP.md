# Integration roadmap: easy first, no lock-in

## Provider categories

| Category | First | Expansion | Integration requirement |
| --- | --- | --- | --- |
| Voice meeting | Google Meet via Recall or Attendee | Zoom, Microsoft Teams, Webex | Audio in/out, chat, participant IDs, leave, raise-hand fallback |
| Messaging | Slack | Microsoft Teams, Discord | Mentions, conversations/threads, source search with per-user permission |
| Project boards | Jira Cloud | monday.com, Linear, Azure DevOps, Trello, Asana | Search/create/read/update, custom fields, assignee mapping, issue link |
| Code & PRs | GitHub | GitLab, Bitbucket | Read source/index, branch creation, checks, draft PR, review protection |
| Calendar | Manual invitation | Google Calendar, Outlook | Explicit invite checking, schedule-based joining only when authorized |

The existence of an HTTP connector **is not proof it works on a real organization account**. Credentials, OAuth grants, restrictions and account-specific settings need live testing.

## Phase 0 — Completed in this project

- Generic contracts and code scaffold.
- Demo running end to end.
- Automated behavior, security-boundary, identity, and provider API-shape tests.
- GitHub read and Jira/monday write connector code (not live-verified).
- Slack signed webhook and reply connector code (not live-verified).
- Recall join/chat connector code (not live-verified).
- Anthropic text-planning connector code (not live-verified).

## Phase 1 — first real end-to-end vertical slice

1. Configure a dedicated test Jira project and a read-only GitHub repository.
2. Verify Jira required fields and assignee account mappings; adapt to the actual project's metadata.
3. Connect Anthropic with an explicitly selected current model and validate JSON planning.
4. Wire Recall Output Media webpage, speech-to-speech bridge, voice activation gating and authenticated meeting events. Measure latency and turn taking.
5. Run a Meet meeting: ask Nogita how code works, create a Jira task, receive the task link in meeting chat. Record only non-content diagnostics.

## Phase 2 — expand initial useful tools

- Support Slack real workspace installation; verify user and channel permissions.
- Provide issue-assignee lookup and ambiguity questions in Jira.
- Map monday.com board columns, including task description, owner and labels.
- Add policy-governed draft PR runner in isolated sandbox, with human review.
- Implement risk assessor with hand-raise UX where platform supports it (no unsolicited speech fallback).
- Add durable deduplication and independent external write status reconciliation.

## Phase 3 — multiplatform

- Meet + Zoom + Teams certification tests via Recall.
- Microsoft Teams messaging integration with Graph permissions and tenant policy.
- More boards via generic task contract adapters.
- Optional Google Calendar/Outlook invites, always explicit opt-in.
- Production-grade per-tenant secrets manager, OAuth installations, audit/privacy documentation.

## What to test before declaring V1 ready

- 20 real engineering meetings, 2+ simultaneous speakers, false wake detection, barge-in, STT noise.
- 30 real task-creation test scenarios including wrong-project/owner ambiguity.
- Cross-account and cross-meeting data isolation and unauthorized-access attempts.
- Meeting exit and cleanup including Recall/provider retention.
- Rate limits, interrupted requests and duplicate webhook replay.
- p90 time to first spoken response, provider costs and interruptions.

## Provider independence milestone

An Attendee meeting adapter has been added for join, provider TTS, meeting chat, leave, signed transcript webhooks, stable speaker UUID mapping, replay suppression, and provider-ended cleanup, with credentials and privacy gates. Stable HTTPS deployment, privacy acceptance, real speaker enrollment, true raise-hand capability and full live integration testing remain blockers. Compare Recall, Attendee, and Meeting BaaS on reliability, cost, retention, participant identification and end-to-end latency before selecting a default.
