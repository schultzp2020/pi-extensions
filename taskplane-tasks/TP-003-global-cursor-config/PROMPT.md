# Task: TP-003 - Global Cursor config with env override

**Created:** 2026-05-04
**Size:** S

## Review Level: 0 (None)

**Assessment:** New standalone module with standard config load/save/resolve pattern. No auth, no data model changes, single file.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-003-global-cursor-config/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

The pi-cursor extension has no persistent user configuration. Native tool
behavior, max mode, model mapping style, and retry count are hardcoded. Users
must edit source code to change any setting.

Create a global config module that loads settings from
`~/.pi/agent/cursor-config.json`, supports environment variable overrides, and
falls back to built-in defaults. This module is the foundation for the `/cursor`
settings command and all configurable behavior added by later tasks.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0007-global-cursor-config-with-env-override.md` — design decisions for config schema, precedence, and resilience

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/config.ts`
- `packages/pi-cursor/src/proxy/config.test.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/` directory exists
- [ ] No existing `config.ts` in the proxy directory
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Create config module

Create `packages/pi-cursor/src/proxy/config.ts` with the following exports:

**Types:**

- `CursorConfig` interface with fields: `version: number`, `nativeToolsMode: 'reject' | 'redirect' | 'native'`, `maxMode: boolean`, `modelMappings: 'normalized' | 'raw'`, `maxRetries: number`

**Constants:**

- `DEFAULT_CONFIG`: `{ version: 1, nativeToolsMode: 'reject', maxMode: false, modelMappings: 'normalized', maxRetries: 2 }`
- `CONFIG_PATH`: `~/.pi/agent/cursor-config.json` (use `homedir()` + `join()`)

**Functions:**

- `loadConfig(): CursorConfig` — Read and parse `cursor-config.json`. On missing file, invalid JSON, or malformed values, return defaults. Ignore unknown fields. Validate each field individually — a bad `nativeToolsMode` doesn't invalidate `maxRetries`.
- `saveConfig(config: Partial<CursorConfig>): void` — Merge provided fields with current config on disk, write to `cursor-config.json`. Create `~/.pi/agent/` directory if missing. Always write `version: 1`.
- `resolveEffective(): CursorConfig` — Load config, then apply environment variable overrides: `PI_CURSOR_NATIVE_TOOLS_MODE`, `PI_CURSOR_MAX_MODE` (truthy string → `true`), `PI_CURSOR_RAW_MODELS` (truthy → `modelMappings: 'raw'`), `PI_CURSOR_MAX_RETRIES` (parse int).
- `getEnvOverrides(): Partial<Record<keyof CursorConfig, string>>` — Return a map of which config fields are currently overridden by environment variables and their env var names. Used by the `/cursor` command to show override indicators.

- [ ] Create `config.ts` with `CursorConfig` type, `DEFAULT_CONFIG`, and `CONFIG_PATH`
- [ ] Implement `loadConfig()` with per-field validation and graceful fallback
- [ ] Implement `saveConfig()` with directory creation and field merging
- [ ] Implement `resolveEffective()` with env var override precedence
- [ ] Implement `getEnvOverrides()` helper

**Artifacts:**

- `packages/pi-cursor/src/proxy/config.ts` (new)

### Step 2: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

Create `packages/pi-cursor/src/proxy/config.test.ts` with tests for:

- `loadConfig()` — missing file returns defaults, valid file returns parsed values, invalid JSON returns defaults, malformed field values fall back per-field (not entire config), unknown fields are ignored
- `saveConfig()` — writes valid JSON, merges with existing config, creates directory if needed
- `resolveEffective()` — env vars override file values, env vars override defaults, multiple env vars compose correctly
- `getEnvOverrides()` — returns correct override map when env vars are set, empty when none set

Use `tmp` directories and env var manipulation in tests. Clean up after each test.

- [ ] Create `config.test.ts` with load/save/resolve/override tests
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/config.test.ts` (new)

### Step 3: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add "Cursor Config" term describing the config module, file path, and precedence chain

**Check If Affected:**

- `packages/pi-cursor/README.md` — Mention config file location if README documents configuration

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] `loadConfig()` returns defaults on missing/invalid file
- [ ] `saveConfig()` creates directory and merges fields
- [ ] `resolveEffective()` applies env vars with correct precedence
- [ ] No existing tests broken

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-003): complete Step N — description`
- **Bug fixes:** `fix(TP-003): description`
- **Tests:** `test(TP-003): description`
- **Hydration:** `hydrate: TP-003 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Import or use the config module from `main.ts` or `index.ts` — consumers integrate in their own tasks
- Add any runtime behavior beyond the config module itself

---

## Amendments (Added During Execution)
