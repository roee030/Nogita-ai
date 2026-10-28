# Meeting Verification and Responsive Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spoken owner verification reliable and improve perceived response latency without guessing answers or changing providers.

**Architecture:** Keep the existing Attendee → Deepgram → command router → engine → Anthropic path. Repair challenge parsing at the router boundary first; then instrument and optimize the existing path before adding optional background reasoning.

**Tech Stack:** Node 22, TypeScript, Node test runner, Attendee, Deepgram, Anthropic.

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-verification-and-response-design.md`

## Global Constraints

- Never persist or log credentials, challenge codes, raw audio, or meeting transcripts.
- A code answer must be grounded in repository evidence; progress speech contains no unverified fact.
- Keep Hebrew-capable Nova-3 as the default STT; Flux is English-only opt-in.
- Sonnet/Opus cannot become an unbounded default expense.
- Each deploy requires full tests, typecheck, and a live health/deploy check. A new meeting test needs the user's active invitation.

## Review Focus

- A spoken digit sequence with punctuation or words must bind only the challenged speaker: Task 1.
- Wrong digits, an extra digit, or a trailing action must not verify: Task 1.
- Slow first-model-token or audio submission must be counted separately without retaining speech: Task 2.
- An interrupted speculative turn must not speak after the user resumes: Task 4.
- Sonnet escalation must not occur on simple questions or when disabled: Task 5.

---

### Task 1: Spoken challenge parsing

**Files:** `src/app/attendee-command-router.ts`, `tests/attendee-command-router.test.ts`

**Interfaces:** Keep `AttendeeCommandRouter.beginSession` and `accept` unchanged; add a private deterministic matcher for `Nogita verify` plus exactly six spoken digits.

- [x] Add tests using the observed transcript variants and negative cases, including same-speaker binding and another-speaker rejection.
- [x] Run the focused test and observe the expected failure.
- [x] Implement digit-word and punctuation normalization without fuzzy code matching.
- [ ] Run focused and full tests, typecheck, and commit.

### Task 2: Stage latency measurements

**Files:** `src/core/contracts.ts`, `src/app/session-usage.ts`, `src/app/attendee-command-router.ts`, `src/adapters/anthropic.ts`, `tests/session-usage.test.ts`

**Interfaces:** Add bounded per-session timing samples for transcript-to-ack, model first token, and audio submission; expose p50/p95 in the protected usage report.

- [ ] Add failing tests for separate timing stages, bounded retention, and no transcript fields.
- [ ] Run focused tests to observe failure.
- [ ] Implement stage recording at actual component boundaries, retaining only numeric durations.
- [ ] Run full tests and typecheck; commit.

### Task 3: Earlier truthful progress

**Files:** `src/core/engine.ts`, `tests/engine.test.ts`

**Interfaces:** Keep `NogitaEngine.onUtterance`; begin progress after a short configurable delay only for verified slow work and serialize speech before the final answer.

- [ ] Add failing tests for fast answer (no filler), slow answer (one varied filler then answer), and leave/cancel (no stale filler).
- [ ] Run focused tests to observe failure.
- [ ] Adjust the progress timer and preserve its no-overlap guard.
- [ ] Run full tests and typecheck; commit.

### Task 4: Streamed answer path and cancellation

**Files:** `src/adapters/anthropic.ts`, `src/core/contracts.ts`, `src/core/engine.ts`, `src/app/attendee-realtime-audio.ts`, `tests/anthropic.test.ts`, `tests/engine.test.ts`, `tests/attendee-realtime-audio.test.ts`

**Interfaces:** Add an opt-in streamed answer method that emits vetted sentence chunks; cancel on speaker resumption or session end; never speak partial structured plans.

- [ ] Add failing SSE parser tests for text deltas, final stop, API errors, truncation, and abort.
- [ ] Add failing turn-cancellation tests proving stale chunks cannot speak.
- [ ] Implement sentence-boundary delivery with backpressure and bounded output.
- [ ] Benchmark first-token and first-audio timings before enabling in a meeting.

### Task 5: Conditional model escalation and code map

**Files:** `src/adapters/anthropic.ts`, `src/adapters/github.ts`, `src/app/config.ts`, `tests/anthropic.test.ts`, `tests/connectors.test.ts`, `.env.example`

**Interfaces:** Retain Haiku as default, add optional Sonnet configuration for difficult grounded code questions, and a bounded source-module summary cache keyed by commit.

- [ ] Add failing routing tests: simple answer uses Haiku; unsupported/complex code question escalates only when enabled; timeout returns a safe answer.
- [ ] Add regression questions for module and cross-file answers and measure quality/latency/cost before selecting default thresholds.
- [ ] Implement bounded config and commit-keyed cache without storing secrets or transcripts.
- [ ] Run full suite, typecheck, and an opt-in live benchmark; deploy only the verified slice.

## Implementation checkpoint

- Spoken challenge parsing now accepts observed digit/wake-word transcription variants while rejecting wrong or extra digits and appended actions. A new meeting test remains necessary after deploy.
- Numeric per-session response stages are implemented for transcript-to-chat submission acknowledgement, model roundtrip, and turn-to-first-speech **attempt**. These are server-side timings, **not** model first-token or listener-audible latency.
- The default slow-work spoken progress delay is 1 second after the router releases a completed turn. Interim human speech cancels pending filler for that old turn. The existing quiet-window delay remains to avoid cutting off a speaker; an old final answer and already-submitted speech still need a full interruption-safe cancellation path.
- An optional complex, multi-file code model can be configured with a per-meeting attempt cap and separate cost estimates. Active meeting counters are retained until the meeting ends. Its calls time out sooner and fall back once to the fast model on provider failure. It is disabled unless `ANTHROPIC_CODE_REASONING_MODEL` is set. This is a routing mechanism, not yet a validated quality or latency gain.
- SSE answer streaming, interruption-safe sentence speech, first-token instrumentation, the code map, and the 20-question benchmark remain open gates. Do not turn on speculative or dual-model speech before those gates pass.
