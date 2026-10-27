# Slack Replay Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist bounded Slack replay markers across restarts without storing Slack message content or identifiers.

**Architecture:** Both Slack entry points use `FileEventLedger` under the `slack` namespace. Claims are completed after successful processing and abandoned on failure; Socket Mode still acknowledges promptly.

**Tech Stack:** Node.js 22+, TypeScript, node:test, filesystem-backed SHA-256 ledger.

**Spec:** `docs/superpowers/specs/2026-10-27-slack-replay-design.md`

## Global Constraints

- Do not persist Slack payloads, message text, raw identifiers, tokens, or credentials.
- Keep state under `NOGITA_STATE_DIR`, which remains ignored by Git.
- KAN-11 remains open for durable unfinished-job recovery and external-effect reconciliation.

## Review Focus

- Duplicate completed delivery after restart must not execute again.
- Concurrent duplicate delivery must not execute twice.
- Failed processing must release the claim for a later retry.
- Socket Mode must acknowledge before slow processing.
- Marker files must contain neither the event ID nor event payload.

---

### Task 1: Reusable claimed-event runner

**Files:**
- Create: `src/app/claimed-event.ts`
- Create: `tests/claimed-event.test.ts`

**Interfaces:**
- Consumes: `FileEventLedger.begin(namespace, eventId)`
- Produces: `runClaimedEvent(ledger, namespace, eventId, work): Promise<'processed' | 'active' | 'completed'>`

- [ ] Write failing tests for success, replay/concurrency suppression, and failure release.
- [ ] Run the focused tests and confirm the missing export failure.
- [ ] Implement the minimal runner.
- [ ] Run focused tests and confirm they pass.

### Task 2: Integrate both Slack entry points

**Files:**
- Modify: `src/app/slack-socket.ts`
- Modify: `src/app/server.ts`
- Modify: `README.md`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `runClaimedEvent(...)`
- Produces: durable completed-event suppression for Socket Mode and HTTP Events API.

- [ ] Replace each in-memory Slack replay set with the shared runner and `NOGITA_STATE_DIR` ledger.
- [ ] Keep Socket Mode acknowledgement before parsing/processing.
- [ ] Document exact guarantees and the remaining KAN-11 crash window.
- [ ] Run the full tests, typecheck, and diff checks.
- [ ] Commit, push, wait for CI, and update KAN-14 with verification evidence.
