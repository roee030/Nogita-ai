# Open Board Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every meaningful open KAN board item, deploy the verified branch, and reconcile Jira against real evidence.

**Architecture:** Extend the existing usage registry with event counters and configurable pricing. Add an AES-256-GCM file queue under the persistent state directory and route Slack/Attendee deliveries through durable enqueue plus a retrying worker. Preserve the existing engine policy, hash-only idempotency ledger, and Jira crash-retry protection.

**Tech Stack:** Node.js 22, TypeScript, Node crypto/filesystem, built-in test runner, Slack, Attendee, Jira, Render.

**Spec:** `docs/superpowers/specs/2026-10-27-open-board-completion-design.md`

## Global Constraints

- Never persist plaintext provider payloads or credentials.
- Preserve explicit-address and actor allowlist checks.
- Keep queue and usage retention bounded.
- Do not mark Jira Done before implementation, tests, deployment, and applicable live proof.

## Review Focus

- A queue file must not contain a recognizable Slack message or transcript fragment.
- A crash after enqueue but before completion must make the event available again.
- Two workers sharing a directory must not claim the same queued event.
- Usage from simultaneous sessions must never be mixed.
- A TTS failure must increment failure count and still produce one chat response.

---

### Task 1: Complete KAN-22 usage accounting

**Files:**
- Modify: `src/core/contracts.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/adapters/anthropic.ts`
- Modify: `src/app/config.ts`
- Modify: `src/app/session-usage.ts`
- Modify: `src/app/server.ts`
- Modify: `.env.example`
- Test: `tests/anthropic.test.ts`
- Test: `tests/session-usage.test.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Produces: per-session model calls, token cost, transcription mode, TTS attempts/failures, external action counts.

- [x] Add failing tests for configurable Claude prices, model call count, TTS failure accounting, action accounting, and session isolation.
- [x] Extend the usage interfaces and registry without retaining prompts or transcript text.
- [x] Pass usage events from the engine and configured prices from environment.
- [x] Run focused tests, full tests, typecheck, and commit.

### Task 2: Complete KAN-11 encrypted durable queue

**Files:**
- Create: `src/app/durable-event-queue.ts`
- Create: `src/app/event-worker.ts`
- Modify: `src/app/server.ts`
- Modify: `src/app/slack-socket.ts`
- Modify: `src/app/readiness.ts`
- Modify: `.env.example`
- Test: `tests/durable-event-queue.test.ts`
- Modify: `tests/readiness.test.ts`

**Interfaces:**
- Produces: `EncryptedFileEventQueue.enqueue`, `claimNext`, `complete`, `retry`, and a bounded worker.
- Consumes: existing provider parsers and hash-only event ledger.

- [x] Add failing tests for encrypted-at-rest content, restart recovery, exclusive claims, retry, tamper rejection, and bounded retention.
- [x] Implement AES-256-GCM atomic queue records and exclusive leases under `NOGITA_STATE_DIR`.
- [x] Route accepted HTTP and Socket Mode events through enqueue before acknowledgement and process them with the existing idempotent handlers.
- [x] Add readiness validation for the deployment-only encryption key.
- [x] Run focused tests, full tests, typecheck, and commit. (Container build is delegated to CI because Docker is unavailable on this host.)

### Task 3: Documentation and branch verification

**Files:**
- Modify: `README.md`
- Modify: `docs/SECURITY.md`
- Modify: this plan

- [x] Document queue recovery, one-instance boundary, key rotation consequence, and complete usage response.
- [x] Run the full suite, typecheck, demo, secret scan, and diff check. (Container build is delegated to CI because Docker is unavailable on this host.)
- [x] Review the whole branch and fix Critical/Important findings with regression tests.
- [ ] Commit final documentation.

### Task 4: Deploy and reconcile Jira

**External systems:** GitHub PR #1, Render service, Jira KAN board.

- [ ] Push `feat/attendee-meeting-provider` and wait for GitHub verification.
- [ ] Verify Render health/readiness and run a controlled live meeting if the deployment is connected to this branch.
- [ ] Add concise evidence comments and transition completed KAN-11, KAN-20, KAN-21, KAN-22, and KAN-23 to Done; leave any genuinely blocked item open with its exact blocker.
- [ ] Comment on KAN-1, KAN-2, and KAN-3 that they are empty setup placeholders, then transition them to Done/obsolete.
- [ ] Re-query the board and report any remaining open issue with evidence.
