# Live Meeting Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live Attendee sessions understand split commands, verify an authorized speaker, reply through voice or chat, and stop idle billing automatically.

**Architecture:** Attendee owns idle/alone leave timers. A focused in-memory router assembles caption fragments and performs session-only challenge enrollment before calling the existing policy engine. The engine owns output fallback so all meeting providers get consistent behavior.

**Tech Stack:** Node.js 22, TypeScript, built-in test runner, Attendee REST/webhooks.

**Spec:** `docs/superpowers/specs/2026-10-27-live-meeting-reliability-design.md`

## Global Constraints

- Never trust display names or persist meeting-scoped identifiers.
- Keep explicit-address, allowlist, replay, and Jira idempotency protections.
- Use 180 seconds for silence and 30 seconds for bot-alone auto-leave.
- Use a 1.2-second fragment quiet window.

## Review Focus

- Interleaved speakers must not share a buffer.
- A wrong or replayed verification phrase must not authorize a speaker.
- A failed TTS request must still produce exactly one chat response.
- A retried transcript delivery must not create duplicate work.
- Session end must clear timers, challenges, and speaker bindings.

---

### Task 1: Provider-managed automatic leave

**Files:**
- Modify: `src/adapters/attendee.ts`
- Test: `tests/attendee.test.ts`

**Interfaces:**
- Produces: Attendee create body with `automatic_leave_settings`.

- [x] Add a failing adapter test for 180-second silence and 30-second only-participant timeouts.
- [x] Run the focused test and confirm the fields are absent.
- [x] Add the two settings to the create request.
- [x] Run adapter tests and the full suite.

### Task 2: Generic chat status and speech fallback

**Files:**
- Modify: `src/core/contracts.ts`
- Modify: `src/adapters/attendee.ts`
- Modify: `src/adapters/demo.ts`
- Modify: `src/adapters/recall.ts`
- Modify: `src/adapters/slack.ts`
- Modify: `src/core/engine.ts`
- Test: `tests/engine.test.ts`
- Test: `tests/attendee.test.ts`

**Interfaces:**
- Produces: `MeetingPort.sendStatus(message: string): Promise<void>` and engine speech fallback.

- [x] Add failing tests showing answers and action acknowledgements fall back to chat exactly once when speech rejects.
- [x] Add `sendStatus` to the port and adapters.
- [x] Centralize engine output through speech-first/chat-fallback behavior.
- [x] Run focused and full tests.

### Task 3: Meeting-scoped verification and transcript assembly

**Files:**
- Create: `src/app/attendee-command-router.ts`
- Modify: `src/app/attendee-webhook.ts`
- Modify: `src/app/server.ts`
- Test: `tests/attendee-command-router.test.ts`
- Modify: `tests/attendee-webhook.test.ts`

**Interfaces:**
- Produces: `AttendeeCommandRouter` accepting transcript fragments, authorized owner enrollment, and session cleanup.
- Consumes: `MeetingPort.sendStatus` from Task 2 and existing `NogitaEngine.onUtterance`.

- [x] Add failing tests for same-speaker assembly, interleaved isolation, wrong challenge, successful challenge, replay safety, and cleanup.
- [x] Expose the meeting-scoped speaker UUID separately from the parsed actor.
- [x] Implement the bounded router with injectable clock/timers and cryptographic challenge generation.
- [x] Extend session creation with optional `ownerActorId`; require it to be allowlisted and post the challenge in meeting chat.
- [x] Route signed transcripts through the assembler and clear it on every session end.
- [x] Run focused and full tests.

### Task 4: Documentation, readiness, and operational proof

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `src/app/readiness.ts`
- Modify: `tests/readiness.test.ts`

**Interfaces:**
- Documents the live flow and remaining external TTS credential requirement.

- [x] Add failing readiness/documentation assertions for the secure owner-enrollment flow and voice fallback.
- [x] Document the session request, verification phrase, auto-leave rules, and TTS prerequisite.
- [x] Run typecheck and the full test suite.

### Task 5: Per-session usage estimate

**Files:**
- Modify: `src/adapters/anthropic.ts`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/engine.ts`
- Create: `src/app/session-usage.ts`
- Modify: `src/app/server.ts`
- Test: `tests/anthropic.test.ts`
- Test: `tests/session-usage.test.ts`

- [x] Attribute provider-reported Claude token counts to the current session without retaining prompts.
- [x] Track Attendee session duration and estimate bot-time cost at a configurable hourly rate.
- [x] Expose an admin-authenticated per-session usage endpoint that remains available after session end.
- [x] Run typecheck and the full test suite.
