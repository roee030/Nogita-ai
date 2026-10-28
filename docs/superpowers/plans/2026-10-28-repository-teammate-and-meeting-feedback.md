# Repository Teammate and Meeting Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nogita answer from the full configured repository with lower latency and provide clear meeting-chat feedback on hearing, slow work, failures, and leaving.

**Architecture:** Warm a complete in-memory index of supported safe text files, add commit-history evidence for change-history questions, and pass initial evidence into the existing planner so grounded answers need one model call. The Attendee router will confirm a verified direct request after its existing quiet window, while lifecycle webhooks make best-effort safe exit/error notices before cleanup.

**Tech Stack:** Node.js 22, TypeScript, built-in test runner, GitHub REST API, Anthropic Messages API, Attendee bot/webhook API.

**Spec:** `docs/superpowers/specs/2026-10-28-repository-teammate-and-meeting-feedback-design.md`

## Global Constraints

- Do not send secrets, raw provider logs, or full transcripts to meeting chat.
- Keep authorization and explicit user-addressing rules unchanged.
- Continue excluding credentials, generated output, binaries, and dependency lockfiles from the repository index.
- Do not claim a meeting-chat message was delivered if Attendee rejected it.
- Use mocked provider/model APIs in tests; do not trigger paid or external mutations.

## Review Focus

- Large or truncated GitHub trees must not be silently presented as complete; test explicit tree expansion or explicit failure.
- Commit questions must use the configured branch and must not be answered from file-content matches; test a configured non-default ref.
- Ambiguous/short utterances must not trigger unsolicited bot speech; test direct-address gating remains intact.
- A failed acknowledgement must not block the actual response or claim it was heard; test delivery failure behavior.
- Provider end/fatal events may arrive after the bot has left; test best-effort notice failure does not prevent cleanup.

---

### Task 1: Full repository evidence and commit history

**Files:**
- Modify: `src/adapters/github.ts`
- Test: `tests/connectors.test.ts`

**Interfaces:**
- Consumes: configured owner, repo, ref and current `CodePort.findEvidence(query)` interface.
- Produces: `findEvidence` searches all supported safe text files and returns commit evidence for explicit recent-change/push/commit queries.

- [ ] Write a failing connector test proving extensionless project files are indexed and a commit-history question queries the configured ref and returns commit title/date/URL.
- [ ] Run the focused test and confirm it fails because those paths are currently not searched.
- [ ] Extend supported text filenames/extensions; remove silent repository-wide count/aggregate caps while preserving the per-file and credential/generated-file filters.
- [ ] Add a TTL-backed revision/index cache so ordinary questions do not request the Git tree every time; keep `prepare()` as a warmup path.
- [ ] Add commit metadata lookup for clear history questions, using `sha=<configured ref>` and returning evidence that the model can cite.
- [ ] Run `node --disable-warning=ExperimentalWarning --experimental-transform-types --test tests/connectors.test.ts` and verify it passes.

### Task 2: One-call grounded repository answers

**Files:**
- Modify: `src/core/contracts.ts`
- Modify: `src/adapters/anthropic.ts`
- Modify: `src/core/engine.ts`
- Test: `tests/anthropic.test.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 `CodePort.findEvidence(query)` results.
- Produces: optional initial evidence parameter on `BrainPort.plan`, with the Anthropic planner returning a grounded concise `answer` when supplied evidence is sufficient.

- [ ] Write failing tests proving evidence reaches the planner prompt and a code answer with initial evidence does not call `answerWithEvidence` a second time.
- [ ] Run the focused tests and confirm they fail because the current planner cannot accept or use repository evidence.
- [ ] Add optional evidence to `BrainPort.plan`; treat snippets as untrusted data and require file/commit attribution in concise answers.
- [ ] Retrieve evidence before planning and pass it into the planner. Retain the existing expanded-query fallback only when the planner explicitly asks for more evidence.
- [ ] Send a code reference when a grounded answer used repository evidence and keep usage counts accurate.
- [ ] Run the Anthropic and engine tests and verify one-call behavior, grounded fallback, and existing write authorization.

### Task 3: Meeting acknowledgements and lifecycle notices

**Files:**
- Modify: `src/app/attendee-command-router.ts`
- Modify: `src/app/attendee-webhook.ts`
- Modify: `src/adapters/attendee.ts`
- Modify: `src/app/server.ts`
- Test: `tests/attendee-command-router.test.ts`
- Test: `tests/attendee-webhook.test.ts`
- Test: `tests/attendee.test.ts`

**Interfaces:**
- Consumes: existing verified speaker identity, combined utterance, bot state-change and Attendee chat APIs.
- Produces: immediate post-quiet-window chat acknowledgement for direct addressed requests, provider log/fatal-event parsing, and best-effort safe notice before session cleanup.

- [ ] Write failing tests for acknowledgement-before-processing, no acknowledgement for non-addressed speech, provider fatal/ended reason parsing, bot-log webhook subscription, and cleanup despite notice failure.
- [ ] Run the focused tests and confirm each new behavior fails for the expected reason.
- [ ] Send a short chat-only acknowledgement for verified direct requests before slow reasoning; leave explicit leave requests on their existing pre-leave message path.
- [ ] Subscribe to `bot_logs.update`, parse only safe event metadata, and map fatal/ended events to generic user-facing notices.
- [ ] Attempt the notice before deleting local session mappings; regardless of notification delivery, complete cleanup and log only a safe failure marker.
- [ ] Run focused Attendee tests and verify existing retry, identity, and leave behavior remains intact.

### Task 4: Full verification

**Files:** none beyond Tasks 1–3.

- [ ] Run `npm test` and verify all tests pass.
- [ ] Run `npm run typecheck` and verify a zero exit code.
- [ ] Run repository guardrails/secrets checks from the configured CI workflow and inspect the final diff for leaked credentials or unrelated edits.
