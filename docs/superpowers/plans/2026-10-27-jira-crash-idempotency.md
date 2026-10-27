# Jira Crash-Safe Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate Jira task creation when the same explicit request is retried after a process crash or restart.

**Architecture:** `JiraBoard` computes a domain-separated SHA-256 digest for `CreateTask.requestId`, searches recent issues for a matching hidden Jira property, and reuses an existing receipt before attempting a create. New issues receive the property atomically in the create payload; lookup failures fail closed.

**Tech Stack:** TypeScript, Node.js built-in crypto, Jira Cloud REST API v3, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-27-jira-crash-idempotency-design.md`

## Global Constraints

- No new dependencies or infrastructure.
- Never transmit or persist the raw `requestId` to Jira.
- Preserve `BoardPort`, `CreateTask`, and `ActionReceipt` interfaces.
- Errors expose status codes only, never Jira response bodies or credentials.
- Recovery lookup must fail closed before any create call.

## Review Focus

- Same request after restart returns the original issue and makes no create call.
- Lookup outage or malformed response causes no write.
- Raw request IDs are absent from all Jira URLs and bodies.
- Invalid Jira keys are never converted into receipts.
- Bounded search examines no more than 100 recent issues in the configured project.

---

### Task 1: Add provider-backed Jira request recovery

**Files:**
- Modify: `src/adapters/jira.ts`
- Modify: `tests/connectors.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `JiraBoard.createTask(task: CreateTask): Promise<ActionReceipt>`.
- Produces: unchanged `createTask` contract with crash-safe retry behavior and exported `jiraRequestDigest(requestId: string): string` for focused verification.

- [x] **Step 1: Write failing connector tests**

Add tests named:

- `Jira create stores only a hashed request marker`
- `Jira retry recovers an existing issue without creating`
- `Jira lookup failure prevents a possibly duplicate create`
- `Jira malformed recovery data fails closed`

Assert the first call is `POST /rest/api/3/search/jql`, its body requests `maxResults: 100`, `fields: ['key']`, and `properties: ['com.nogita.request.v1']`; assert the create body contains a 64-character lowercase hex digest and no serialized raw request ID. For retry, return one valid issue with a matching property and assert exactly one HTTP call. For failure and malformed data, assert rejection and no second call.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --experimental-transform-types --test tests/connectors.test.ts`

Expected: FAIL because recovery search, request hashing, and Jira properties are not implemented.

- [x] **Step 3: Implement minimal recovery in `JiraBoard`**

Add:

- `export function jiraRequestDigest(requestId: string): string`
- `private receipt(key: string): ActionReceipt`
- `private async findExisting(requestDigest: string): Promise<ActionReceipt | undefined>`

Use SHA-256 with the versioned prefix `nogita:jira-request:v1\0`. Send the bounded enhanced-search POST before creation. Parse only an array of issue objects with valid Jira keys and optional `properties['com.nogita.request.v1'].digest`. Include the same property in the issue-create body. Throw `Jira recovery search failed: HTTP <status>` or `Jira recovery search returned invalid data` without response bodies.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --disable-warning=ExperimentalWarning --experimental-transform-types --test tests/connectors.test.ts`

Expected: all connector tests pass.

- [x] **Step 5: Document the recovery boundary**

Update `README.md` to state that Jira task retries use a hidden hashed request property and a bounded recent-issue lookup, preventing the primary restart duplicate case without storing raw event IDs; clarify that multi-deployment exactly-once behavior still requires stronger coordination.

- [x] **Step 6: Run full verification**

Run: `npm test && npm run typecheck`

Expected: all tests pass and TypeScript reports no errors.

- [x] **Step 7: Commit**

```bash
git add .gitignore src/adapters/jira.ts tests/connectors.test.ts README.md docs/superpowers/specs/2026-10-27-jira-crash-idempotency-design.md docs/superpowers/plans/2026-10-27-jira-crash-idempotency.md
git commit -m "fix: recover Jira task retries after restart"
```
