# Task: TP-008 - Retry execution for transient Cursor failures

**Created:** 2026-05-04
**Size:** S

## Review Level: 0 (None)

**Assessment:** Wires existing RetryHint signals to a retry loop in the request handler. Single file change following standard retry patterns. No auth, no data model changes.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-008-retry-execution/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

The proxy can detect retryable failures — `CursorSession` emits `RetryHint`
values (`blob_not_found`, `resource_exhausted`, `timeout`) in the done event —
but never actually retries. Transient Cursor errors kill the conversation.

Wire the existing `retryHint` signal to an actual retry loop in the chat
completion handler. Use the `maxRetries` setting from the config module to
control retry count.

## Dependencies

- **Task:** TP-003 (config module must exist for `maxRetries` setting)

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0002-proxy-handles-transient-retries.md` — retry responsibility split

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/main.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/main.ts` exists with chat completion handler that calls `pumpSession`
- [ ] `packages/pi-cursor/src/proxy/cursor-session.ts` exports `RetryHint` type and emits `retryHint` in done events
- [ ] `packages/pi-cursor/src/proxy/config.ts` exists (TP-003 dependency)
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Implement retry loop

In `packages/pi-cursor/src/proxy/main.ts`:

- Import `resolveEffective` from `config.ts`.
- In the chat completion handler, wrap the session creation + pump cycle in a
  retry loop. When `pumpSession` returns a result with `retryHint`:
  1. Check if retries remain (`attempt < maxRetries` from `resolveEffective()`)
  2. Close the failed session and remove it from active sessions
  3. Create a new session with the same parameters (conversation state is
     preserved via checkpoint — the new session resumes from the last committed
     checkpoint)
  4. Increment attempt counter and retry
  5. On final failure, return the error to the client as-is

- Add appropriate delay between retries: immediate for `blob_not_found` (Cursor
  may need a moment to process blobs), 1-2 seconds for `resource_exhausted`,
  1 second for `timeout`.

- Log each retry attempt at info level so transient failures are visible in
  proxy output.

- [ ] Import and read `maxRetries` from config
- [ ] Wrap session pump in retry loop with attempt counting
- [ ] Add retry delay based on `retryHint` type
- [ ] Log retry attempts
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/main.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- No new test files — retry behavior requires integration testing with a real proxy. Verify no regressions.

### Step 3: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add or update "Retry" description to note that transient failures are now retried up to `maxRetries` times

**Check If Affected:**

- `packages/pi-cursor/README.md` — Mention retry behavior if error handling is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Transient failures with `retryHint` trigger retry up to `maxRetries`
- [ ] Non-retryable errors are returned immediately
- [ ] Retry attempts are logged
- [ ] Conversation state survives retries via checkpoint

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-008): complete Step N — description`
- **Bug fixes:** `fix(TP-008): description`
- **Tests:** `test(TP-008): description`
- **Hydration:** `hydrate: TP-008 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Add retry logic for non-retryable errors (auth failures, subscription expired)
- Change the `RetryHint` types or `CursorSession` done event format
- Add infinite retry — always respect `maxRetries` ceiling

---

## Amendments (Added During Execution)
