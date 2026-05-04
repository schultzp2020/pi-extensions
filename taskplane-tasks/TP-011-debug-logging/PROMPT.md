# Task: TP-011 - Structured debug logging and timeline

**Created:** 2026-05-04
**Size:** M

## Review Level: 0 (None)

**Assessment:** New logging module and script with minor hook additions to existing files. No auth, no data model changes, easy revert. Adapts standard logging patterns.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-011-debug-logging/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

When things go wrong with the Cursor proxy, there is no structured way to
diagnose what happened. Users and developers must manually inspect console
output to understand request/response sequences, session lifecycle, and error
chains.

Add structured JSONL debug logging gated behind `PI_CURSOR_PROVIDER_DEBUG=1`,
with extension-level lifecycle hooks and proxy-level event logging. Include a
timeline script that transforms JSONL logs into human-readable summaries.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/debug-logger.ts`
- `packages/pi-cursor/src/proxy/main.ts`
- `packages/pi-cursor/src/index.ts`
- `packages/pi-cursor/scripts/debug-log-timeline.mjs`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/main.ts` exists with the chat completion handler
- [ ] `packages/pi-cursor/src/index.ts` exists with the extension entry point
- [ ] No existing `debug-logger.ts` in the proxy directory
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Create debug logger module

Create `packages/pi-cursor/src/proxy/debug-logger.ts`:

- Export `DebugLogger` class or a set of functions gated behind
  `PI_CURSOR_PROVIDER_DEBUG=1`.
- When disabled, all log functions are no-ops (zero overhead).
- When enabled, write JSONL to a log file. Default path:
  `~/.pi/agent/cursor-debug.jsonl`. Configurable via
  `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`.
- Each log entry should include: `timestamp` (ISO 8601), `type` (event type),
  `sessionId`, `requestId` (per-request UUID), and type-specific payload.

**Event types to support:**

- `request_start` — new chat completion request (model, message count, tools count)
- `request_end` — request completed (duration_ms, token counts, error if any)
- `session_create` — new CursorSession created (session key, conversation key)
- `session_resume` — existing session reused
- `checkpoint_commit` — checkpoint stored (turn count, size bytes)
- `checkpoint_discard` — stale checkpoint discarded (reason)
- `retry` — transient failure retried (attempt, hint, delay_ms)
- `tool_call` — tool execution (tool name, mode, result type)
- `bridge_open` — H2 stream opened to Cursor
- `bridge_close` — H2 stream closed (reason, duration_ms)
- `lifecycle` — extension lifecycle event (event name)

- [ ] Create `debug-logger.ts` with JSONL logging gated behind env var
- [ ] Implement all event type log functions
- [ ] Ensure zero overhead when disabled (no-op functions)
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/debug-logger.ts` (new)

### Step 2: Wire logging into proxy and extension

In `packages/pi-cursor/src/proxy/main.ts`:

- Import and initialize the debug logger.
- Add log calls at key points: request start/end, session create/resume,
  checkpoint operations, retry attempts, tool calls.

In `packages/pi-cursor/src/index.ts`:

- Add extension-level lifecycle logging for `message_start`, `message_update`,
  `message_end`, `context`, `turn_end` events (if Pi's extension API supports
  these hooks — investigate available hooks).
- Log lifecycle events (`session_shutdown`, `session_before_switch`, etc.) to
  the debug logger.

- [ ] Wire debug logging into proxy request handling in `main.ts`
- [ ] Add extension-level lifecycle event logging in `index.ts`
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/main.ts` (modified)
- `packages/pi-cursor/src/index.ts` (modified)

### Step 3: Create timeline script

Create `packages/pi-cursor/scripts/debug-log-timeline.mjs`:

- Read a JSONL debug log file (from stdin or first argument).
- Group events by `requestId`.
- Output a human-readable timeline per request showing:
  - Request start → session state → tool calls → checkpoint ops → response → duration
- Support filtering by session ID (`--session`) and time range (`--since`, `--until`).
- Include a summary section at the end: total requests, errors, retries,
  average duration.

- [ ] Create `debug-log-timeline.mjs` with JSONL parsing and timeline output
- [ ] Support filtering by session and time range
- [ ] Include summary statistics

**Artifacts:**

- `packages/pi-cursor/scripts/debug-log-timeline.mjs` (new)

### Step 4: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`
- [ ] Manual smoke test: set `PI_CURSOR_PROVIDER_DEBUG=1`, verify JSONL output, pipe to timeline script

### Step 5: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add "Debug Logger" definition describing env var gating, JSONL format, and timeline script

**Check If Affected:**

- `packages/pi-cursor/README.md` — Document debug logging setup and timeline usage

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] `PI_CURSOR_PROVIDER_DEBUG=1` enables JSONL logging
- [ ] Log file path configurable via `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`
- [ ] Zero overhead when debug logging is disabled
- [ ] Timeline script produces readable output from JSONL logs
- [ ] Timeline script supports session and time filtering

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-011): complete Step N — description`
- **Bug fixes:** `fix(TP-011): description`
- **Tests:** `test(TP-011): description`
- **Hydration:** `hydrate: TP-011 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Enable debug logging by default — it must be opt-in via env var
- Log sensitive data (auth tokens, full message content) — log metadata only
- Add runtime dependencies for the timeline script — use Node.js built-ins only

---

## Amendments (Added During Execution)
