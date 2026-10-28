# Voice and Repository Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repository answers verifiable and voice turns natural enough for repeatable meeting tests.

**Architecture:** Separate repository retrieval and audio turn detection behind existing ports. Improve each with measurable fixtures before changing live provider behavior. Keep multilingual Nova-3 as the default while an English Flux mode is evaluated.

**Tech Stack:** TypeScript, Node 22, GitHub REST API, Attendee, Deepgram, Anthropic, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-28-voice-and-repository-quality-design.md`

## Global constraints

- Never expose repository evidence to an unauthorized speaker.
- Preserve Hebrew support through Nova-3 while Flux remains English-only.
- Never claim humanlike voice or full-repository competence from unit tests alone.

## Review focus

- A long supported source file must not make all repository queries fail.
- A truncated GitHub tree must be expanded or reported as incomplete, never treated as complete.
- A mid-sentence pause must not trigger an answer before resumed speech is collected.
- An interruption must stop queued TTS and playback audio, not merely start listening.
- An unauthenticated speaker must receive no private code or Jira action.

---

### Task 1: Baseline repository and voice evaluation

**Files:** Create `tests/fixtures/repository-questions.json`; create `tests/repository-evaluation.test.ts`; create `docs/voice-evaluation.md`.

- [x] Define 12 local repository questions with expected source paths and one unanswerable probe. Commit-history and authorization cases remain for the next fixture revision.
- [x] Run current retrieval against the fixtures: baseline recall@4 is 12/15 (80%) on answerable source targets; answer quality is not measured by this score.
- [x] Define a consented meeting script and latency/turn-taking rubric; do not store raw audio or transcripts in the repository.

### Task 2: Complete, revision-pinned repository retrieval

**Files:** Modify `src/adapters/github.ts`; test `tests/connectors.test.ts`.

- [x] Add failing tests for a recursive tree marked `truncated` and a medium-sized source file (both RED→GREEN); changed-HEAD and files beyond 1 MiB remain.
- [ ] Traverse subtrees non-recursively when needed (tested); pin blob links to the exact commit (tested); index text in bounded chunks still pending. Exclude credentials, generated files, and binary blobs. Public source lookup now uses Git's read-only ref advertisement and pinned codeload archive without API quota.
- [ ] Test deterministic ranking on the evaluation set (local recall@4 improved from 12/15 to 14/15); add a bounded second lookup for multi-hop questions when the first evidence is insufficient.

### Task 3: English Flux turn detection behind a feature flag

**Files:** Modify `src/app/attendee-realtime-audio.ts`, `src/app/server.ts`, and `tests/attendee-realtime-audio.test.ts`.

- [ ] Add synthetic `TurnInfo` tests for `StartOfTurn`, `Update`, and `EndOfTurn` (RED→GREEN); duplicate-turn simulated socket test passes, resumed-speech integration remains.
- [ ] Connect `/v2/listen?model=flux-general-en` only in the opt-in English mode; simulated socket test confirms transcript only on `EndOfTurn` and Nova-3 as default. Live verification remains.
- [x] Test the active provider configuration and Hebrew-capable Nova-3 default without a paid API call.

### Task 4: Interruptible and expressive speech

**Files:** Modify `src/app/attendee-realtime-audio.ts`, `src/adapters/attendee.ts`, and speech tests.

- [ ] Add a failing test that interruption clears Deepgram's TTS buffer (RED→GREEN for pending speech); pacing now stops locally queued Attendee frames (RED→GREEN), but proving Attendee has stopped already submitted audio remains.
- [ ] Implement cancellation for the current spoken turn without losing its chat receipt; pending TTS and carry are cleared, filler avoids immediate repeats. Already-buffered Attendee playback remains unverified.
- [ ] Compare at least three documented voice candidates in a consented call using a fixed question script; choose by listener ratings and measured latency, then make the selected voice configurable.

### Task 5: Integration and release

- [x] Run full tests, typecheck, and diff whitespace check (202 passing at latest full run); `.env` remains Git-ignored. Independent review completed and its remaining release gates are recorded in the SDD ledger.
- [ ] Verify GitHub, Jira, Slack, and meeting paths in the deployed environment without printing tokens.
- [ ] Run a short consented meeting with the evaluation script; record counts and latency summaries, then deploy only the verified revision.
