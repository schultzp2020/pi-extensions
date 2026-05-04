# Task: TP-010 - /cursor settings command

**Created:** 2026-05-04
**Size:** M

## Review Level: 0 (None)

**Assessment:** Single-file extension command using Pi's `registerCommand` and `ctx.ui.select` APIs. Integrates existing config module and model normalization. No auth, no data model changes.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-010-cursor-settings-command/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

There is no user-facing way to configure the pi-cursor extension. Users cannot
change `nativeToolsMode`, `maxMode`, `modelMappings`, or `maxRetries` without
editing source code or setting environment variables.

Implement a `/cursor` command that opens a single-level settings menu. Each
setting row opens a second selector with valid values. Settings persist
immediately to `cursor-config.json`. When `modelMappings` changes, trigger
provider re-registration to update the model picker. Show environment override
indicators when applicable.

## Dependencies

- **Task:** TP-003 (config module for load/save/resolve)
- **Task:** TP-006 (model normalization for provider re-registration on modelMappings change)

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/index.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/index.ts` exists with the extension's `default` export
- [ ] `packages/pi-cursor/src/proxy/config.ts` exists (TP-003 dependency) with `loadConfig`, `saveConfig`, `resolveEffective`, `getEnvOverrides`
- [ ] Model normalization from TP-006 is present
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Register /cursor command

In `packages/pi-cursor/src/index.ts`:

- Register a `/cursor` command via `pi.registerCommand()` with name `cursor`,
  description `Cursor provider settings`.
- The command handler should:
  1. Load effective config via `resolveEffective()`
  2. Get env overrides via `getEnvOverrides()`
  3. Build a settings menu with rows for each setting, showing current value
     and `[ENV]` indicator when overridden by environment variable
  4. Show the menu via `ctx.ui.select()` (or Pi's equivalent select API)
  5. When a setting is selected, show a second selector with valid values
  6. On value selection, call `saveConfig()` with the new value
  7. If `modelMappings` changed, trigger provider re-registration:
     - Re-process models with the new normalization mode
     - Call `pi.registerProvider()` again with the updated model list
     - Preserve the current model selection via best-match reconstruction

**Settings rows:**

| Setting           | Values                         | Notes                              |
| ----------------- | ------------------------------ | ---------------------------------- |
| Native Tools Mode | `reject`, `redirect`, `native` | Default: `reject`                  |
| Max Mode          | `on`, `off`                    | Hidden when `modelMappings=raw`    |
| Model Mappings    | `normalized`, `raw`            | Triggers re-registration on change |
| Max Retries       | `0`, `1`, `2`, `3`, `5`        | Default: `2`                       |

- [ ] Register `/cursor` command with `pi.registerCommand()`
- [ ] Implement settings menu with current values and env override indicators
- [ ] Implement value selection sub-menus for each setting
- [ ] Persist changes via `saveConfig()` on selection
- [ ] Trigger provider re-registration when `modelMappings` changes
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/index.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

### Step 3: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add "`/cursor` Command" definition describing the settings menu and its interaction with config and model normalization

**Check If Affected:**

- `packages/pi-cursor/README.md` — Document the `/cursor` command and available settings

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] `/cursor` command shows settings menu with current values
- [ ] Environment override indicators shown when env vars are set
- [ ] Settings persist to `cursor-config.json` immediately
- [ ] `modelMappings` change triggers provider re-registration
- [ ] `maxMode` row hidden/disabled when `modelMappings=raw`

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-010): complete Step N — description`
- **Bug fixes:** `fix(TP-010): description`
- **Tests:** `test(TP-010): description`
- **Hydration:** `hydrate: TP-010 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Implement nested/hierarchical menus — keep it single-level
- Allow editing env-overridden settings via the menu — show them as read-only
- Add per-session or per-project config — config is global only

---

## Amendments (Added During Execution)
