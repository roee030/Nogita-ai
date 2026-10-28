# Meeting conversation continuity

## Intent

Nogita must respond to an authorized speaker's direct request, including a vocative name later in the same turn, and must preserve enough short-lived context to handle a reply to her own question. A progress phrase must be followed by the outcome of the same request. Explicit leave commands must not be delegated to the LLM.

## Evidence and constraints

- In the 2026-10-28 meeting, "Let's do them both. Nogita, ..." and "Yes, please" were ignored by start-of-turn name detection, while "Nogita drop this meeting" fell through to the model. These are reproduced locally by `directlyAddressesNogita` and `isExplicitLeaveRequest`.
- The current engine stores user transcript lines but not its own answers. Anthropic's Messages API is stateless; the application must supply context for each request.
- Deepgram's Nova-3 `speech_final` is pause-based; the existing 1,200 ms fragment quiet window remains until a measured voice evaluation justifies changing it.
- The working tree contains earlier uncommitted changes. Preserve them. No paid live meeting or production deploy is part of this change.

## Approach

Use the existing per-meeting ephemeral session. Broaden direct-address detection only for sentence-initial vocatives and explicit second-person vocatives, never arbitrary mentions of Nogita. Store delivered assistant messages in bounded, role-typed history so a participant display name cannot impersonate the assistant. Treat a short, verified reply to Nogita's recent explicit question as a continuation only if it arrived after that question, but never infer authorization for a write action from it. Recognize narrow affirmative "drop/end this meeting/call" leave commands deterministically; negations, calendar discussion, and ambiguous questions are not leave commands.

## Success criteria

- Transcript-derived regression tests fail before and pass after each change.
- Non-addressed mentions and unrelated/unauthorized speech remain silent.
- A verified "Yes, please" to Nogita's own recent read-only question continues it once; unrelated speech and stale replies do not.
- The model receives prior delivered assistant answer text as conversation data; no raw transcript is persisted outside the meeting session.
- A direct "drop this meeting" invokes provider leave, not the model.
- Full test suite and typecheck pass; live behavior remains unverified until deployment and a consented short call.
