# Task: TP-009 - Native tools mode with proxy-local execution

**Created:** 2026-05-04
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Adds three-mode tool dispatch with proxy-local filesystem execution and sandboxing. Adapts existing tool routing patterns. Touches tool execution boundaries (security-adjacent for sandboxing).
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-009-native-tools-mode/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

The extension's native tool handling is hardcoded: overlapping tools are always
redirected through Pi equivalents with no user control. The `request-context.ts`
always emits "prefer mcp*pi*\* tools" guidance regardless of what mode would be
appropriate.

Implement the three-mode native tools policy (`reject`, `redirect`, `native`)
controlled by the `nativeToolsMode` config setting. In `native` mode, implement
proxy-local execution of overlapping tools (read, write, delete, ls, grep,
shell) sandboxed to the Allowed Root (nearest git root of the session's working
directory).

## Dependencies

- **Task:** TP-003 (config module must exist for `nativeToolsMode` setting)

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0005-native-tools-mode-policy.md` — three modes, default `reject`, breaking change rationale

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/request-context.ts`
- `packages/pi-cursor/src/proxy/native-tools.ts`
- `packages/pi-cursor/src/proxy/native-tools.test.ts`
- `packages/pi-cursor/src/proxy/cursor-session.ts`
- `packages/pi-cursor/src/proxy/cursor-messages.ts`
- `packages/pi-cursor/src/proxy/main.ts`
- `packages/pi-cursor/src/index.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/request-context.ts` exists with `buildRequestContext` and hardcoded MCP instructions
- [ ] `packages/pi-cursor/src/proxy/native-tools.ts` exists with `classifyExecMessage` and tool classification
- [ ] `packages/pi-cursor/src/proxy/config.ts` exists (TP-003 dependency)
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Mode-dependent prompt guidance

In `packages/pi-cursor/src/proxy/request-context.ts`:

- Import `resolveEffective` from `config.ts`.
- Modify `buildRequestContext()` to accept the native tools mode (or read it
  from config) and adjust MCP instructions accordingly:
  - `reject` mode: Keep "prefer mcp*pi*\* tools" guidance (current behavior)
  - `redirect` mode: Keep "prefer mcp*pi*\* tools" guidance (redirects are
    transparent to the model)
  - `native` mode: Remove "prefer mcp*pi*\* tools" guidance — let the model use
    Cursor's native tools directly
- Make the `mcpInstructions` array conditional on mode.

In `packages/pi-cursor/src/proxy/main.ts`:

- Pass the resolved `nativeToolsMode` through to `buildRequestContext()`.

- [ ] Make prompt guidance conditional on native tools mode
- [ ] Pass mode through to `buildRequestContext()` in main.ts
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/request-context.ts` (modified)
- `packages/pi-cursor/src/proxy/main.ts` (modified)

### Step 2: Mode-aware tool dispatch

In `packages/pi-cursor/src/proxy/cursor-messages.ts`:

- Read the native tools mode from the `MessageProcessorContext` (add the field
  if not present).
- Modify `handleExecMessage()` to use the mode when routing:
  - `reject`: All native exec messages get rejected (current default after TP-002)
  - `redirect`: Overlapping tools redirect to MCP (existing behavior when
    tool is enabled), remaining tools rejected
  - `native`: Overlapping tools dispatch to proxy-local execution (Step 3),
    remaining tools rejected

In `packages/pi-cursor/src/proxy/cursor-session.ts` or `main.ts`:

- Pass the resolved `nativeToolsMode` into `MessageProcessorContext` when
  constructing it.

- [ ] Add `nativeToolsMode` to `MessageProcessorContext`
- [ ] Modify tool dispatch to branch on mode (reject/redirect/native)
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/cursor-messages.ts` (modified)
- `packages/pi-cursor/src/proxy/cursor-session.ts` (modified)

### Step 3: Proxy-local native tool execution

In `packages/pi-cursor/src/proxy/native-tools.ts`:

- Add `AllowedRoot` concept: a function `resolveAllowedRoot(cwd: string): string`
  that finds the nearest git root containing `cwd` (walk up looking for `.git`),
  falling back to `cwd` itself.
- Add `validatePath(filePath: string, allowedRoot: string): string` that
  resolves the path and verifies it's within the allowed root. Throws on
  violation.
- Implement proxy-local execution functions for each overlapping tool in
  `native` mode:
  - `readArgs` → `fs.readFile` within allowed root
  - `writeArgs` → `fs.writeFile` within allowed root
  - `deleteArgs` → `fs.unlink` within allowed root
  - `lsArgs` → `fs.readdir` within allowed root
  - `grepArgs` → spawn `grep`/`rg` process within allowed root
  - `shellArgs`/`shellStreamArgs` → spawn child process with `cwd` set to
    allowed root, inheriting normal process environment
  - `fetchArgs` → Node.js `fetch()` (no filesystem sandboxing needed)

In `packages/pi-cursor/src/index.ts`:

- Capture `ctx.cwd` when the extension loads and pass it to the proxy via the
  internal API or request headers so the proxy can compute the Allowed Root
  per session.

- [ ] Implement `resolveAllowedRoot()` and `validatePath()` for sandboxing
- [ ] Implement proxy-local execution for each overlapping tool type
- [ ] Pass `ctx.cwd` from extension to proxy for Allowed Root computation
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/native-tools.ts` (modified)
- `packages/pi-cursor/src/index.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

Extend `packages/pi-cursor/src/proxy/native-tools.test.ts` with tests for:

- `resolveAllowedRoot()` — finds git root, falls back to cwd
- `validatePath()` — allows paths within root, rejects paths outside root, rejects path traversal (`../`)
- Mode-aware dispatch — `reject` rejects all, `redirect` redirects overlapping, `native` dispatches to local execution
- Proxy-local read/write/delete — basic operations within allowed root, rejection outside root

- [ ] Add sandboxing and mode dispatch tests to `native-tools.test.ts`
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/native-tools.test.ts` (modified)

### Step 5: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Update "Native Tools Mode" and "Allowed Root" definitions to reflect implementation details

**Check If Affected:**

- `packages/pi-cursor/README.md` — Document the three native tools modes and how to configure them

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] `reject` mode rejects all native tool calls
- [ ] `redirect` mode redirects overlapping tools through Pi equivalents
- [ ] `native` mode executes overlapping tools locally within Allowed Root
- [ ] Path traversal outside Allowed Root is rejected in `native` mode
- [ ] Prompt guidance varies by mode

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-009): complete Step N — description`
- **Bug fixes:** `fix(TP-009): description`
- **Tests:** `test(TP-009): description`
- **Hydration:** `hydrate: TP-009 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Implement remaining tools (backgroundShellSpawn, webSearch, etc.) — they reject in all modes
- Remove the `mcp_pi_*` tool prefix stripping logic — it's still needed for redirect mode
- Allow unrestricted filesystem access in `native` mode — always enforce Allowed Root

---

## Amendments (Added During Execution)
