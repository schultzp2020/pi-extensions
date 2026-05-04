# Task: TP-014 - Request Lifecycle Module

**Created:** 2026-05-04
**Size:** L

## Review Level: 1 (Plan Only)

**Assessment:** Largest refactoring step — extracts the core request handling path from the 955-line main.ts god module. Touches the critical request path but preserves all behavior exactly. Higher blast radius (multiple modules, core path) offset by pure refactoring nature and easy reversibility.
**Score:** 3/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-014-request-lifecycle-module/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Extract the `handleChatCompletion` path from `main.ts` (955 lines) into a deep **Request Lifecycle** module. This is the largest and most impactful step of the Proxy architecture deepening — it transforms `main.ts` from a god module into a thin startup + routing shell (~200 lines) and concentrates the entire request handling path behind one deep interface.

The Request Lifecycle module owns the full lifecycle of a single `/v1/chat/completions` request:

1. Parse request body (extract model, messages, stream flag, tools, pi_session_id, pi_cwd, reasoning_effort)
2. Resolve model (normalize model ID, apply Effort Resolution and Max Mode)
3. Parse messages (OpenAI → parsed messages with conversation turns)
4. Resolve Session State (via the Session State module from TP-012)
5. Validate Checkpoint Lineage (detect stale checkpoints from forks/compaction)
6. Build protobuf `RunRequest` (construct the Cursor protobuf request with blobs, request context, cloud rule)
7. Create Bridge (instantiate CursorSession)
8. Retry on transient failures (blob_not_found, resource_exhausted, timeout — per ADR-0002)
9. Stream or collect response (delegate to openai-stream for SSE, or collect for non-streaming)
10. Commit Checkpoint and Lineage after successful turn

The request builder (`buildRunRequest` and `foldTurnsIntoSystemPrompt`) is an **internal seam** — used inside the lifecycle module, not exposed to callers except for testing.

A new **Proxy Context** type carries stable per-Proxy state into each request: access token (or getter), normalized model set, conversation directory, global Cursor Config, and Debug Logger functions.

Single entry point: `handleChatCompletion(req, res, ctx: ProxyContext)`.

This task consumes the Session State module (TP-012) — it calls `resolveSession`, `registerBridge`, and `commitTurn` instead of manually coordinating session-manager and conversation-state.

## Dependencies

- **Task:** TP-012 (Session State module must exist — Request Lifecycle consumes its interface)

## Context to Read First

**Tier 2 (area context):**

- `taskplane-tasks/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/CONTEXT.md` — domain glossary (Request Lifecycle, Proxy Context, Session State, Bridge, Checkpoint, Effort Resolution, Max Mode, Cloud Rule, Native Tools Mode definitions)
- `packages/pi-cursor/docs/adr/0001-standalone-proxy-architecture.md` — why Proxy is standalone (context for what stays in main.ts)
- `packages/pi-cursor/docs/adr/0002-proxy-handles-transient-retries.md` — retry responsibility (must stay inside Proxy, which Request Lifecycle is)
- `packages/pi-cursor/docs/adr/0006-model-normalization-and-effort-mapping.md` — Effort Resolution behavior to preserve
- `packages/pi-cursor/docs/adr/0008-checkpoint-lineage-for-fork-and-compaction-safety.md` — lineage validation flow to preserve
- `docs/prd-proxy-architecture-deepening.md` — full PRD with design rationale

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/request-lifecycle.ts` (new)
- `packages/pi-cursor/src/proxy/request-lifecycle.test.ts` (new)
- `packages/pi-cursor/src/proxy/main.ts` (modified — major shrink from ~955 to ~200 lines)
- `packages/pi-cursor/src/proxy/request-builder.test.ts` (modified — retarget imports)

## Steps

### Step 0: Preflight

- [ ] Read `main.ts` — map the full `handleChatCompletion` path: identify every function, helper, and module-level state it uses; identify what must move vs. what stays
- [ ] Read `session-state.ts` (from TP-012) — understand the interface this task consumes (`resolveSession`, `registerBridge`, `commitTurn`)
- [ ] Read `openai-stream.ts` — understand the streaming/non-streaming delegation interface
- [ ] Read `request-builder.test.ts` — understand existing test coverage for `foldTurnsIntoSystemPrompt`
- [ ] Identify module-level state in `main.ts` that the lifecycle module needs (e.g., `cachedNormalizedSet`, access token, conversation dir) — these become Proxy Context fields

### Step 1: Define Proxy Context and extract request-lifecycle.ts

- [ ] Define `ProxyContext` type with: access token getter, `getNormalizedSet()` for model resolution, conversation directory, global Cursor Config (nativeToolsMode, maxMode, maxRetries), Debug Logger functions
- [ ] Create `request-lifecycle.ts` exporting `handleChatCompletion(req, res, ctx: ProxyContext)`
- [ ] Move `handleChatCompletion` and all its internal helpers from `main.ts`: body parsing, model resolution (`resolveModelId` call), message parsing (`parseMessages` call), Session State integration (`resolveSession`/`registerBridge`/`commitTurn`), request building (`buildRunRequest`, `foldTurnsIntoSystemPrompt`), Bridge creation (`new CursorSession`), retry loop with backoff, streaming delegation (`pumpSession`/`collectNonStreamingResponse`), Checkpoint commit logic, client disconnect handling
- [ ] Export `buildRunRequest` and `foldTurnsIntoSystemPrompt` for testing (internal seam)
- [ ] Run targeted tests: `npm test -- --grep "request-builder"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/request-lifecycle.ts` (new)

### Step 2: Slim down main.ts and retarget tests

- [ ] Slim `main.ts` to ~200 lines: startup sequence (stdin config read, model discovery, HTTP server creation, ready signal to stdout), HTTP routing (thin delegation to `handleChatCompletion` for `/v1/chat/completions`), model management (`getNormalizedSet`, model discovery, caching), Internal API delegation
- [ ] Construct `ProxyContext` in `main.ts` and pass to `handleChatCompletion`
- [ ] Retarget `request-builder.test.ts` imports to `request-lifecycle.ts`
- [ ] Create `request-lifecycle.test.ts` with tests for: retry behavior (mock CursorSession returns `blob_not_found` on first attempt, succeeds on second — verify retry with backoff), lineage invalidation (stale lineage → Checkpoint discarded, conversation reset via Session State), Checkpoint commit (successful turn → `commitTurn` called with correct data), streaming vs non-streaming response format
- [ ] Run targeted tests: `npm test -- --grep "request-lifecycle\|request-builder"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/main.ts` (modified)
- `packages/pi-cursor/src/proxy/request-builder.test.ts` (modified)
- `packages/pi-cursor/src/proxy/request-lifecycle.test.ts` (new)

### Step 3: Testing & Verification

- [ ] Run FULL test suite: `npm test`
- [ ] Fix all failures
- [ ] Build passes: `npm run build`
- [ ] Verify `main.ts` is ~200 lines (no request handling logic remaining)
- [ ] Verify `handleChatCompletion` is not defined in `main.ts`
- [ ] Verify `request-lifecycle.ts` does not import from deleted `session-manager` or `conversation-state` — only from `session-state`

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — verify Request Lifecycle, Proxy Context definitions match the implementation; update Relationships section if any wording changed

**Check If Affected:**

- `packages/pi-cursor/docs/adr/0001-standalone-proxy-architecture.md` — confirm Proxy is still standalone, main.ts is still the entry point
- `packages/pi-cursor/docs/adr/0002-proxy-handles-transient-retries.md` — confirm retry loop is still inside the Proxy (now in request-lifecycle.ts)
- `packages/pi-cursor/docs/adr/0006-model-normalization-and-effort-mapping.md` — confirm Effort Resolution preserved
- `packages/pi-cursor/docs/adr/0008-checkpoint-lineage-for-fork-and-compaction-safety.md` — confirm lineage validation flow preserved

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `main.ts` is ~200 lines with no request handling logic
- [ ] `request-lifecycle.ts` exports `handleChatCompletion` and `ProxyContext`
- [ ] `request-builder.test.ts` imports from `request-lifecycle.ts`
- [ ] New `request-lifecycle.test.ts` covers retry, lineage, checkpoint, streaming
- [ ] Documentation updated

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-014): complete Step N — description`
- **Bug fixes:** `fix(TP-014): description`
- **Tests:** `test(TP-014): description`
- **Hydration:** `hydrate: TP-014 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Change any external HTTP API contracts (routes, response formats, SSE format)
- Modify `cursor-session.ts`, `native-tools.ts`, `openai-stream.ts`, or `openai-messages.ts` — they are consumed, not modified
- Change retry behavior, Checkpoint commit timing, lineage validation logic, or streaming format — only restructure where the code lives
- Add new features or capabilities — this is a pure refactoring
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution.
     Format:
     ### Amendment N — YYYY-MM-DD HH:MM
     **Issue:** [what was wrong]
     **Resolution:** [what was changed] -->
