# Meeting Conversation Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ignored direct requests, lost follow-ups, and model-invented leave behavior in Attendee meetings.

**Architecture:** Keep safe routing in `policy.ts`, per-meeting state in `engine.ts`, and the existing Attendee command router. Add short-lived, read-only follow-up context and delivered assistant turns to bounded history; do not change the audio provider.

**Tech Stack:** TypeScript, Node 22 test runner, Attendee, Anthropic.

**Spec:** `docs/superpowers/specs/2026-10-28-conversation-continuity-design.md`

## Global Constraints

- Preserve verification and authorization: no code evidence for an unverified speaker, no write action inferred from an undirected follow-up.
- Preserve the existing quiet window until a real voice evaluation supports changing it.
- No secret in Git, no production deploy or paid meeting test in this plan.

## Review Focus

- Third-person mentions of Nogita must not wake the bot.
- An affirmative reply from a different speaker must not inherit the original speaker's pending request.
- Stale or repeated replies must not replay a prior request.
- A follow-up must never create a Jira task or draft PR without a new explicit direct command.
- Leave recognition must match only call/meeting exit commands, not ordinary "drop" discussion.

---

### Task 1: Direct-address and leave routing

**Files:** Modify `src/core/policy.ts`, `tests/engine.test.ts`, `tests/attendee-command-router.test.ts`.

**Interfaces:** Produces `directlyAddressesNogita`, `removeAddress`, and `isExplicitLeaveRequest` with unchanged signatures for the engine and router.

- [x] Add failing tests for sentence-initial `Nogita` later in a turn, `How are you Nogita today?`, third-person mention safety, and `Nogita drop this meeting` routing.
- [x] Run focused tests; confirm the new cases fail for the observed reasons.
- [x] Make the smallest policy change; run focused tests and the full suite. Independent review also drove negated/question leave and third-person regressions.

### Task 2: Read-only reply continuity and assistant history

**Files:** Modify `src/core/engine.ts`, `src/adapters/anthropic.ts`, `src/core/contracts.ts`, `tests/engine.test.ts`, `tests/anthropic.test.ts` as needed.

**Interfaces:** Consumes Task 1 direct-address behavior; keeps `BrainPort.plan` signature; produces bounded assistant context and one recent per-speaker read-only pending question in `NogitaEngine`.

- [x] Add failing tests for a verified `Yes, please` after Nogita's question, assistant answer in next model context, speaker isolation, expiration/one-shot consumption, and no write-action inference.
- [x] Run focused tests; confirm expected failures.
- [x] Implement ephemeral pending question and role-typed assistant history; ensure the Anthropic planner uses the supplied assistant context as data and does not repeatedly request permission for explicit reads. Independent review also drove queued-before-question and display-name-spoofing regressions.
- [x] Run focused tests, full suite, typecheck, and diff check.

### Task 3: Release evidence and operational handoff

**Files:** Modify `docs/voice-evaluation.md` only if test rubric lacks ignored-turn and progress-to-answer checks.

**Interfaces:** Consumes Task 1–2 behavior; produces a repeatable consented-call test script and exact deploy gate, not a production release.

- [x] Add a short spoken test script covering direct requests, follow-up, repository answers, progress, and leave, with exact timing checkpoints.
- [x] Verify docs and full automated checks; report local vs deployed status and known limits. Live meeting remains a separate release gate.
