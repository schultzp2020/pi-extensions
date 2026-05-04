# Task: TP-012 - Session State Module

**Created:** 2026-05-04
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Pure refactoring that merges two existing modules into one deeper module. Multiple files change but all behavior is preserved — no new capabilities, no security implications, easily reversible.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-012-session-state-module/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Merge the shallow `session-manager.ts` (75 lines — fails the deletion test) and `conversation-state.ts` (251 lines) into a single deep **Session State** module that manages the active Bridge and Conversation State (Checkpoint, Blob Store, Checkpoint Lineage) as a unit, keyed by Session ID.

This deepening concentrates session lifecycle operations (resolve, register, commit, cleanup, evict) behind one interface, eliminates the manual coordination that `main.ts` currently does between two separate modules, and hides key derivation as an internal implementation detail. Callers pass the raw Session ID and never see derived hash keys.

The key design decisions:

- **Single key**: one internal key derived from Session ID replaces the two separate `deriveSessionKey`/`deriveConversationKey` functions
- **Asymmetric lifetime**: evicting a conversation also closes its Bridge (a Bridge without conversation state is useless); closing a Bridge (`cleanup`) does NOT evict its conversation (the conversation persists for future turns)
- **One TTL**: single 30-minute TTL for both, one eviction sweep

This is a pure refactoring — all external contracts (HTTP API, Internal API) are preserved exactly.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `taskplane-tasks/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/CONTEXT.md` — domain glossary (Session State, Session ID, Bridge, Checkpoint, Blob Store, Checkpoint Lineage definitions)
- `packages/pi-cursor/docs/adr/0004-session-identity-from-pi-session-id.md` — session identity keying decisions
- `packages/pi-cursor/docs/adr/0008-checkpoint-lineage-for-fork-and-compaction-safety.md` — lineage validation behavior to preserve
- `docs/prd-proxy-architecture-deepening.md` — full PRD with design rationale

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/session-state.ts` (new)
- `packages/pi-cursor/src/proxy/session-state.test.ts` (new)
- `packages/pi-cursor/src/proxy/session-manager.ts` (deleted)
- `packages/pi-cursor/src/proxy/session-manager.test.ts` (deleted)
- `packages/pi-cursor/src/proxy/conversation-state.ts` (deleted)
- `packages/pi-cursor/src/proxy/conversation-state.test.ts` (deleted)
- `packages/pi-cursor/src/proxy/main.ts` (modified — update imports)
- `packages/pi-cursor/src/proxy/internal-api.ts` (modified — update imports)

## Steps

### Step 0: Preflight

- [ ] Read `session-manager.ts`, `session-manager.test.ts` — understand the full interface and test coverage
- [ ] Read `conversation-state.ts`, `conversation-state.test.ts` — understand the full interface, disk persistence, lineage validation, and test coverage
- [ ] Read `main.ts` — identify every call site that coordinates between session-manager and conversation-state
- [ ] Read `internal-api.ts` — identify `cleanupSessionById` import and usage

### Step 1: Create session-state.ts

- [ ] Create `session-state.ts` merging all functionality from `session-manager.ts` and `conversation-state.ts`
- [ ] Implement single internal key derivation from Session ID (replace `deriveSessionKey` + `deriveConversationKey` with one internal function)
- [ ] Export the unified interface: `resolveSession(sessionId, history)`, `registerBridge(sessionId, bridge)`, `commitTurn(sessionId, checkpoint, lineage)`, `cleanup(sessionId)`, `evict()`, `invalidateSession(sessionId)`, `closeAll()`
- [ ] Implement asymmetric lifetime: `cleanup` closes Bridge but keeps conversation; `evict` removes both; evicting a conversation also closes its Bridge
- [ ] Preserve all existing conversation-state internals: disk persistence, cache, blob pruning, lineage fingerprinting, lineage validation, conversation reset
- [ ] Run targeted tests: `npm test -- --grep "session\|conversation"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/session-state.ts` (new)

### Step 2: Create session-state.test.ts and update imports

- [ ] Create `session-state.test.ts` — merge and expand tests from `session-manager.test.ts` and `conversation-state.test.ts`
- [ ] Add tests for: fresh resolve, disk reload after cache eviction, lineage validation + reset on mismatch, Bridge registration + retrieval via `resolveSession`, `commitTurn` persistence, `cleanup` closes Bridge but conversation survives, `evict` removes stale entries and closing conversation also closes Bridge, callers use Session ID not derived keys
- [ ] Update `main.ts` — replace all imports from `session-manager` and `conversation-state` with imports from `session-state`; simplify coordination logic to use the unified interface
- [ ] Update `internal-api.ts` — replace `cleanupSessionById` import with `cleanup` from `session-state`
- [ ] Delete `session-manager.ts`, `session-manager.test.ts`, `conversation-state.ts`, `conversation-state.test.ts`
- [ ] Run targeted tests: `npm test -- --grep "session-state"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/session-state.test.ts` (new)
- `packages/pi-cursor/src/proxy/main.ts` (modified)
- `packages/pi-cursor/src/proxy/internal-api.ts` (modified)
- `packages/pi-cursor/src/proxy/session-manager.ts` (deleted)
- `packages/pi-cursor/src/proxy/session-manager.test.ts` (deleted)
- `packages/pi-cursor/src/proxy/conversation-state.ts` (deleted)
- `packages/pi-cursor/src/proxy/conversation-state.test.ts` (deleted)

### Step 3: Testing & Verification

- [ ] Run FULL test suite: `npm test`
- [ ] Fix all failures
- [ ] Build passes: `npm run build`
- [ ] Verify no `deriveSessionKey` or `deriveConversationKey` appears in any import outside `session-state.ts`
- [ ] Verify `session-manager.ts` and `conversation-state.ts` no longer exist

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — verify Session State definition matches the implementation; update Relationships section if any wording changed

**Check If Affected:**

- `packages/pi-cursor/docs/adr/0004-session-identity-from-pi-session-id.md` — confirm session keying still aligns
- `packages/pi-cursor/docs/adr/0008-checkpoint-lineage-for-fork-and-compaction-safety.md` — confirm lineage validation behavior preserved

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `session-manager.ts` and `conversation-state.ts` deleted
- [ ] `main.ts` and `internal-api.ts` import only from `session-state.ts` for session/conversation operations
- [ ] Documentation updated

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-012): complete Step N — description`
- **Bug fixes:** `fix(TP-012): description`
- **Tests:** `test(TP-012): description`
- **Hydration:** `hydrate: TP-012 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Change any external HTTP API contracts or Internal API contracts
- Modify `cursor-session.ts`, `native-tools.ts`, or `openai-stream.ts`
- Change the behavior of lineage validation, disk persistence, or blob pruning — only restructure where the code lives
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution.
     Format:
     ### Amendment N — YYYY-MM-DD HH:MM
     **Issue:** [what was wrong]
     **Resolution:** [what was changed] -->
