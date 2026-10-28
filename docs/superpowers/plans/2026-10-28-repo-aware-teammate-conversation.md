# Repo-aware Teammate Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Nogita answer from a bounded index of the full configured repository and make meeting replies feel natural, concise, and well-timed.

**Architecture:** `GitHubCode` fetches a revision-pinned tree and bounded blobs, warms its in-memory searchable index in the background at startup, caches by tree SHA, ranks paths and content, and returns compact matched excerpts. `NogitaEngine` emits at most one delayed, varied progress acknowledgment for slow addressed work; Anthropic prompts shape concise teammate answers; `AttendeeCommandRouter` waits for same-speaker quiet time after provider-final turns.

**Tech Stack:** Node.js 22, TypeScript, built-in fetch, Node test runner, existing GitHub and Anthropic adapters.

**Spec:** `docs/superpowers/specs/2026-10-28-repo-aware-teammate-conversation-design.md`

## Global Constraints
- Index at most 300 files and 5 MiB total, each file at most 100 KiB.
- Return at most four evidence excerpts, each at most 2400 characters.
- Never fetch known secret/credential paths (`.env*`, `secrets/`, `credentials.*`, `service-account.*`, private keys/bundles), dependency, generated, build, vendor, coverage, Git, or lock files. Secrets embedded in ordinary source files remain a filename-filtering limitation.
- Cache only in process memory and key it by selected tree SHA.
- Progress delay is 900 ms, only one phrase per request, and no identical consecutive phrase per meeting.
- Same-speaker provider-final debounce uses the existing 1200 ms quiet window.
- Do not alter authorization, repository write behavior, or external action policy.

## Review Focus
- A Git tree marked truncated or a repository beyond configured caps must not cause unbounded retrieval or silently claim full evidence.
- Blob failures, malformed base64, or invalid JSON must not poison the cache permanently or leak provider response bodies.
- Query terms present only in code contents must still find generically named files.
- Fast answers must not produce stale progress speech; slow answers must not speak their final response before the progress phrase finishes.
- Resumed interim speech from the same speaker must reset the provider-final timer without duplicating interim text; speakers must never be merged.
- Repository search must keep concrete terms from the original user question when the planner rewrites it.

---

### Task 1: Full-repository bounded GitHub evidence index

**Files:**
- Modify: `src/adapters/github.ts`
- Test: `tests/connectors.test.ts`

**Interfaces:**
- Consumes: existing `CodePort.findEvidence(query: string): Promise<Evidence[]>`.
- Produces: optional `CodePort.prepare(): Promise<void>` for startup warmup and the same `findEvidence` interface, indexing all eligible files for the configured tree SHA and returning up to four excerpts ranked by path and content relevance.

- [x] **Step 1: Write failing tests**
  - A term found only in contents of `src/engine.ts` is returned for a generic query.
  - Two queries on unchanged tree make blob requests once; a changed tree SHA fetches fresh blobs.
  - Calling `prepare()` before a question means that question reuses the warm index.
  - `.env`, credential, lock, generated and excluded files are never fetched; malformed/failed blob does not poison a retry; malformed provider JSON never leaks its body.
  - Relevant excerpts include the matching lines, and unrelated file prefixes are not returned.
- [x] **Step 2: Run `node --disable-warning=ExperimentalWarning --experimental-transform-types --test --test-name-pattern="GitHub source lookup" tests/connectors.test.ts` and confirm the content-index tests fail for the existing path-only behavior.**
- [x] **Step 3: Implement bounded, revision-keyed in-memory blob indexing and weighted content/path scoring in `src/adapters/github.ts`.**
- [x] **Step 4: Run the targeted connector tests and confirm all GitHub source lookup tests pass.**
- [x] **Step 5: Run `npm test` and `npm run typecheck`.**

### Task 2: Teammate-style concise answers and progress acknowledgments

**Files:**
- Modify: `src/adapters/anthropic.ts`
- Modify: `src/core/engine.ts`
- Test: `tests/anthropic.test.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: indexed `Evidence[]` from Task 1 and existing meeting `speak` / `sendStatus` behavior.
- Produces: conversational, grounded answer prompt plus one delayed progress utterance for requests exceeding 900 ms.

- [x] **Step 1: Write failing tests**
  - Provider request prompt specifies direct teammate tone, source-path attribution, a 55-word/four-sentence answer ceiling, and uncertainty when evidence is insufficient.
  - The planner preserves caller wording and adds code synonyms/concepts; the engine searches with both strings.
  - Even if the model ignores the prompt, the returned spoken answer is capped at 55 words and four sentences.
  - A quick addressed request speaks only its final answer.
  - A delayed code lookup speaks exactly one progress line before final answer.
  - Sequential slow requests within one session do not use the same progress line consecutively.
  - TTS failure for a progress phrase follows existing chat fallback without duplicate chat messages.
- [x] **Step 2: Run the targeted Anthropic and engine tests and confirm they fail for missing teammate/ack behavior.**
- [x] **Step 3: Add concise teammate prompt guidance and an engine helper that cancels unused timers, orders progress before the final answer, and selects a non-repeating phrase per session.**
- [x] **Step 4: Run targeted Anthropic and engine tests and confirm they pass.**
- [x] **Step 5: Run `npm test` and `npm run typecheck`.**

### Task 3: Respect provider-final speech pauses

**Files:**
- Modify: `src/app/attendee-command-router.ts`
- Test: `tests/attendee-command-router.test.ts`

**Interfaces:**
- Consumes: completed provider-final transcript requests.
- Produces: the existing buffered utterance after the same-speaker quiet timer expires, with adjacent fragments combined and other speakers kept separate.

- [x] **Step 1: Replace the immediate-flush test with failing tests**
  - `acceptFinal` schedules the quiet-window timer and emits nothing before it runs.
  - A second final fragment from the same speaker cancels/resets the timer and combines text.
  - Non-empty interim speech by a speaker with a pending final turn cancels/resets the timer without becoming duplicate utterance text.
  - A second speaker stays isolated while each speaker gets its own timer.
- [x] **Step 2: Run `node --disable-warning=ExperimentalWarning --experimental-transform-types --test --test-name-pattern="provider-final|same-speaker|different speakers" tests/attendee-command-router.test.ts` and confirm the immediate-flush behavior fails the new expectations.**
- [x] **Step 3: Make `acceptFinal` retain the `accept` buffer and quiet timer without synchronously flushing it.**
- [x] **Step 3a: Feed non-empty interim speech activity into the same-speaker router buffer so a resumed speaker resets the quiet timer without adding duplicate transcript text.**
- [x] **Step 4: Run targeted router tests and confirm they pass.**
- [x] **Step 5: Run full test suite and typecheck.**

## Completion
- Run `npm test` and `npm run typecheck` after all tasks.
- Inspect the final diff for secret-path exclusion, bounded work, unchanged authorization, and no stale timer paths.
- Do not push, merge, or run a live paid meeting test.
