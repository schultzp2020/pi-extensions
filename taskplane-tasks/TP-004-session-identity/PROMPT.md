# Task: TP-004 - Session identity from pi_session_id with lifecycle cleanup

**Created:** 2026-05-04
**Size:** M

## Review Level: 2 (Plan + Code)

**Assessment:** Changes session key derivation across proxy and extension, adds lifecycle hooks, and adds CancelAction on disconnect. Touches session identity (security-adjacent) and requires careful migration from content-based to ID-based keys.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Canonical Task Folder

```
taskplane-tasks/TP-004-session-identity/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Sessions break after compaction because conversation keys are derived from
message content. When Pi compacts history, the first user message changes,
producing different keys and orphaning all stored state (checkpoints, blob
stores, active bridges). Fork and branch navigation also silently corrupt state
because there is no lifecycle cleanup.

Switch to stable session identity derived from Pi's real session ID injected
via `before_provider_request`, add lifecycle cleanup hooks for session
transitions, and send an explicit CancelAction protobuf on client disconnect
so Cursor stops processing abandoned turns.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0004-session-identity-from-pi-session-id.md` — design decision for session ID injection and key derivation

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/index.ts`
- `packages/pi-cursor/src/proxy/session-manager.ts`
- `packages/pi-cursor/src/proxy/main.ts`
- `packages/pi-cursor/src/proxy/cursor-session.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/index.ts` exists and has the `session_shutdown` hook
- [ ] `packages/pi-cursor/src/proxy/session-manager.ts` exists with `deriveSessionKey` and `deriveConversationKey`
- [ ] `packages/pi-cursor/src/proxy/main.ts` extracts session ID from `X-Session-Id` header
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Inject pi_session_id via before_provider_request

In `packages/pi-cursor/src/index.ts`:

- Register a `before_provider_request` hook that injects the real Pi session ID
  as `pi_session_id` in the request body. The real session ID should come from
  `pi.sessionId` or equivalent Pi API — investigate what the extension API
  provides for the current session's stable ID.
- Remove the `crypto.randomUUID()` session ID generation.
- Keep the `X-Session-Id` header as a fallback for backward compat, but set it
  to the real Pi session ID instead of a random UUID.

- [ ] Register `before_provider_request` hook to inject `pi_session_id` into request body
- [ ] Replace random UUID with real Pi session ID
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/index.ts` (modified)

### Step 2: Stabilize session key derivation

In `packages/pi-cursor/src/proxy/session-manager.ts`:

- Modify `deriveSessionKey()` to use only the session ID — remove the first
  user message content from the hash input. New derivation:
  `sha256("session:{sessionId}")`.
- Modify `deriveConversationKey()` to use only the session ID — remove the first
  user message content. New derivation: `sha256("conv:{sessionId}")`.
- Keep function signatures accepting `messages` parameter for backward compat
  but ignore it when a real session ID is present.

In `packages/pi-cursor/src/proxy/main.ts`:

- Extract `pi_session_id` from the request body (preferred) with fallback to
  `X-Session-Id` header. Pass it through to session/conversation key derivation.

- [ ] Stabilize `deriveSessionKey()` and `deriveConversationKey()` to use session ID only
- [ ] Extract `pi_session_id` from request body in `main.ts` with header fallback
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/session-manager.ts` (modified)
- `packages/pi-cursor/src/proxy/main.ts` (modified)

### Step 3: Add lifecycle cleanup and CancelAction

In `packages/pi-cursor/src/index.ts`:

- Add lifecycle hooks: `session_before_switch`, `session_before_fork`,
  `session_before_tree`. Each should call a cleanup endpoint on the proxy's
  internal API (e.g., `POST /internal/cleanup-session`) passing the current
  session ID.
- Update the existing `session_shutdown` hook to also call the cleanup endpoint.

In `packages/pi-cursor/src/proxy/internal-api.ts` or `session-manager.ts`:

- Add a cleanup function that closes all active sessions for a given session ID
  and evicts their conversation state from cache.

In `packages/pi-cursor/src/proxy/cursor-session.ts`:

- On client disconnect (when the request is aborted), send an explicit
  `CancelAction` protobuf message to Cursor before closing the H2 stream. Use
  the existing `ConversationActionSchema` with a cancel action type. Do NOT
  commit the pending checkpoint on disconnect — preserve the previous committed
  checkpoint.

- [ ] Add `session_before_switch`, `session_before_fork`, `session_before_tree` hooks in `index.ts`
- [ ] Add session cleanup endpoint/function for proxy
- [ ] Send CancelAction protobuf on client disconnect in `cursor-session.ts`
- [ ] Preserve previous checkpoint on interrupted turns
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/index.ts` (modified)
- `packages/pi-cursor/src/proxy/cursor-session.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] Verify session key stability: same session ID → same keys regardless of message content
- [ ] Verify lifecycle hooks are registered and callable
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/session-manager.ts` (tests may be added inline or in new test file)

### Step 5: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Update "Session ID" definition to reflect `before_provider_request` injection and stable key derivation. Add note about lifecycle cleanup hooks.

**Check If Affected:**

- `packages/pi-cursor/README.md` — Update if session behavior is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Session keys are stable across compaction (same session ID → same keys)
- [ ] Lifecycle hooks clean up proxy state on switch/fork/tree/shutdown
- [ ] CancelAction sent on client disconnect
- [ ] Pending checkpoints are NOT committed on interrupted turns

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-004): complete Step N — description`
- **Bug fixes:** `fix(TP-004): description`
- **Tests:** `test(TP-004): description`
- **Hydration:** `hydrate: TP-004 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Change the OpenAI API contract between Pi and the proxy beyond adding `pi_session_id`
- Remove `X-Session-Id` header support entirely — keep as fallback

---

## Amendments (Added During Execution)
