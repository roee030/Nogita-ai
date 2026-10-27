# Live Meeting Reliability Design

## Intent

Make Nogita safe and useful in a real Google Meet: it must understand commands split across caption updates, verify the person who is allowed to trigger external actions, respond in voice when possible, fall back to meeting chat when voice is unavailable, and leave before idle bot time wastes credits.

## Goals

- Combine adjacent final transcript fragments from one speaker into one command after a short quiet window.
- Verify a meeting-scoped speaker without trusting a changeable display name. An admin-authenticated session creator names an authorized internal owner; Nogita posts a random spoken verification phrase in meeting chat and binds the speaker who repeats it only for that session.
- Preserve the existing stable `speaker_user_uuid` identity mapping when Google Meet supplies it.
- Deliver every directly addressed answer or action status through speech, with chat as the automatic fallback when speech fails.
- Configure Attendee to leave after 180 seconds of silence and after 30 seconds as the only remaining participant.
- Keep transcript text, speaker UUIDs, challenges, and credentials out of durable state and logs.
- Report a bounded in-memory per-session estimate for Attendee time and Claude token usage without retaining prompts.

## Non-goals

- Trusting participant display names.
- Persisting a meeting-scoped speaker binding across meetings or restarts.
- Creating or purchasing external TTS credentials.
- Autonomous writes from general meeting discussion that does not directly address Nogita.

## Approach

Use Attendee's provider-managed automatic leave settings so the rule survives Nogita server restarts. Add an application-layer transcript assembler keyed by session and meeting-scoped speaker ID; it emits a combined utterance after 1.2 seconds without another fragment. Add a per-session spoken challenge created with cryptographic randomness and supplied only through meeting chat. Extend the meeting port with a plain status-message operation, then centralize speech-with-chat-fallback in the engine.

Alternatives rejected: trusting the visible Google Meet name is insecure; requiring Slack approval for every action is safe but prevents natural in-meeting operation; server-only leave timers are fragile across deployments.

## Constraints

- External writes remain allowlisted and explicit.
- A challenge may bind only to the authorized internal owner named by an admin-authenticated session request.
- A meeting-scoped binding expires when the session ends.
- Adjacent fragments from different speakers must never be combined.
- Existing webhook signature verification, replay suppression, and Jira idempotency remain intact.
