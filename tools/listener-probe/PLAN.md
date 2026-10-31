# Listener-side Meet Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record listener-side Meet audio and produce comparable question-to-sound and wait-to-silence measurements.

**Architecture:** A localhost browser recorder exports audio plus an RMS/marker JSON sidecar. Pure TypeScript analysis converts sidecars into per-trial metrics and Markdown comparison reports; a small CLI serves the recorder or writes reports.

**Tech Stack:** Node 22 TypeScript, browser MediaRecorder/Web Audio, `node:test`.

**Spec:** `tools/listener-probe/DESIGN.md`

## Global Constraints

- No new dependency and no network upload.
- Only `tools/listener-probe/` and `tests/listener-probe.test.ts` change.
- Missing acoustic transitions are explicit `null` values.

## Review Focus

- A one-frame click must not count as audible response.
- Speech after “wait” must delay silence until a full quiet window.
- A marker near the end of a recording must yield missing data, not zero.
- Out-of-order frames and markers must be normalized deterministically.
- Reports must retain missing samples and comparable meeting labels.

### Task 1: Analysis and report

**Files:** Create `tools/listener-probe/analyse.ts`, `tests/listener-probe.test.ts`

**Interfaces:** Produces `analyseSession(session)` and `renderComparison(results)`.

- [ ] Write tests for sustained sound, sustained silence, missing transitions, sorting, and comparison output.
- [ ] Run the focused test and observe the missing-module failure.
- [ ] Implement the minimal pure analysis and report functions.
- [ ] Run the focused test and observe it pass.

### Task 2: Local recorder and CLI

**Files:** Create `tools/listener-probe/recorder.html`, `tools/listener-probe/run.ts`, `tools/listener-probe/README.md`

**Interfaces:** `record [--port N]` serves the recorder; `report <json...> [--out file]` writes Markdown.

- [ ] Add a CLI integration test for report file output and argument validation.
- [ ] Run the focused test and observe failure.
- [ ] Implement the localhost server, browser capture/export, and report command.
- [ ] Run focused and full verification.
