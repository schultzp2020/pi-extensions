# Task: TP-006 - Model normalization and effort mapping

**Created:** 2026-05-04
**Size:** L

## Review Level: 1 (Plan Only)

**Assessment:** New parsing and mapping logic with complex suffix semantics (triple-max, xhigh+max coexistence). Adapts existing model registration patterns but introduces substantial new logic. No auth or data model changes.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 2, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-006-model-normalization/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Cursor exposes 169+ raw model variants encoding effort level, speed, thinking
mode, and max capability in the model ID. Pi's `/model` picker shows all of
them, making model selection tedious and confusing. Users must manually pick
effort-suffixed model IDs instead of using Pi's reasoning-effort setting.

Implement model normalization that collapses raw Cursor variants into
deduplicated Pi-visible models, builds per-family effort maps so Pi's
reasoning-effort setting controls the variant, and resolves the final Cursor
model ID at request time. Controlled by the `modelMappings` config setting.

## Dependencies

- **Task:** TP-003 (config module must exist for `modelMappings` setting)

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0006-model-normalization-and-effort-mapping.md` — parsing rules, effort map logic, three meanings of max
- `packages/pi-cursor/docs/prd-cursor-settings-and-model-normalization.md` — effort mapping table, modelMappings setting behavior, max mode interaction

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/model-normalization.ts`
- `packages/pi-cursor/src/proxy/model-normalization.test.ts`
- `packages/pi-cursor/src/proxy/models.ts`
- `packages/pi-cursor/src/proxy/main.ts`
- `packages/pi-cursor/src/index.ts`
- `packages/pi-cursor/src/cursor-models-raw.json`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/models.ts` exists with `CursorModel` interface and model discovery
- [ ] `packages/pi-cursor/src/proxy/config.ts` exists (TP-003 dependency)
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Create model normalization module

Create `packages/pi-cursor/src/proxy/model-normalization.ts` with:

**`parseModelId(rawId: string): ParsedModelId`**

Parse a raw Cursor model ID by stripping suffixes in order:

1. Strip trailing `-max` → `maxMode: true` (this is the maxMode flag, NOT effort)
2. Strip `-fast` → `fast: true`
3. Strip `-thinking` → `thinking: true`
4. Parse effort from last remaining segment: `none`, `low`, `medium`, `high`, `xhigh`, `max` → `effort: string | null`
5. Remaining segments → `base: string`

Must handle triple-max correctly: `claude-4.6-opus-max-thinking-fast-max`
→ base `claude-4.6-opus`, effort `max`, thinking `true`, fast `true`, maxMode `true`.

Must handle base name `max`: `gpt-5.1-codex-max` → base `gpt-5.1-codex-max`,
effort `null` (no separate effort suffix).

**`processModels(rawModels: CursorModel[]): NormalizedModelSet`**

Group raw models by `(base, variant)` where variant = combination of fast/thinking.
Collapse groups with multiple effort levels into single entries with
`supportsReasoningEffort: true`. Build effort maps per family.

Return both the deduplicated model list and the effort/variant metadata needed
for resolution.

**`buildEffortMap(availableEfforts: Set<string>): Record<string, string>`**

Map Pi's effort levels to the best available Cursor suffix:

- `minimal` → `none` if available, else `low`, else lowest
- `low` → `low`
- `medium` → `medium` or no suffix (default)
- `high` → `high`
- `xhigh` → `max` if available, else `xhigh`, else `high`

Handle the case where `xhigh` and `max` coexist (e.g. `gpt-5.2` family).

**`resolveModelId(normalizedId: string, effort: string | null, maxMode: boolean, modelSet: NormalizedModelSet): string`**

Reconstruct the final Cursor model ID at request time: base + effort suffix +
variant suffixes + maxMode suffix. Silently skip maxMode if family has no max
variant.

**`supportsReasoningModelId(rawId: string, modelSet: NormalizedModelSet): boolean`**

Check if a given model supports reasoning effort (i.e., has multiple effort
variants in its family).

- [ ] Implement `parseModelId()` with correct suffix stripping order
- [ ] Implement `processModels()` to deduplicate and build family metadata
- [ ] Implement `buildEffortMap()` with fallback chain
- [ ] Implement `resolveModelId()` for request-time reconstruction
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/model-normalization.ts` (new)

### Step 2: Integrate normalization into model registration

In `packages/pi-cursor/src/proxy/main.ts`:

- Import `resolveEffective` from `config.ts` and `processModels`/`resolveModelId`
  from `model-normalization.ts`.
- When `modelMappings === 'normalized'`, use `processModels()` to deduplicate
  the model list before returning from `/v1/models`.
- At request time in the chat completion handler, use `resolveModelId()` to
  reconstruct the final Cursor model ID from the normalized ID + Pi's
  reasoning-effort setting + maxMode config.
- When `modelMappings === 'raw'`, pass raw models through unchanged (current behavior).

In `packages/pi-cursor/src/index.ts`:

- When registering the provider, use normalized models in `toProviderModels()`
  and set `compat.supportsReasoningEffort` and `compat.reasoningEffortMap` for
  models that have effort variants.
- On `modelMappings` change, trigger provider re-registration to update the
  model picker. Preserve the current model selection via best-match
  reconstruction.

Create `packages/pi-cursor/src/cursor-models-raw.json`:

- Static fallback model list for pre-login availability. Include the known
  Cursor model IDs from the `MODEL_LIMITS` map in `models.ts` as a starting
  point, with basic metadata (id, reasoning, contextWindow, supportsImages).

- [ ] Integrate normalization into `/v1/models` endpoint based on `modelMappings`
- [ ] Add effort resolution at request time in chat completion handler
- [ ] Set provider compat fields for reasoning effort support in `index.ts`
- [ ] Create `cursor-models-raw.json` fallback model list
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/main.ts` (modified)
- `packages/pi-cursor/src/index.ts` (modified)
- `packages/pi-cursor/src/cursor-models-raw.json` (new)

### Step 3: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

Create `packages/pi-cursor/src/proxy/model-normalization.test.ts` with tests for:

- `parseModelId()` — standard effort suffixes, trailing `-max` stripping, triple-max model IDs (`claude-4.6-opus-max-thinking-fast-max`), base name `max` (`gpt-5.1-codex-max`), no-suffix models, `-fast` only, `-thinking` only
- `processModels()` — single-effort families collapse correctly, multi-effort families produce effort maps, variant grouping (fast/thinking as separate entries)
- `buildEffortMap()` — all Pi effort levels map correctly, `xhigh`+`max` coexistence, single-effort collapse, empty effort set
- `resolveModelId()` — reconstructs correct raw ID, maxMode appended when supported, maxMode silently ignored when unsupported
- `supportsReasoningModelId()` — true for multi-effort families, false for single-effort

- [ ] Create `model-normalization.test.ts` with comprehensive tests
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/model-normalization.test.ts` (new)

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add/update "Model Normalization", "Effort Map", "Effort Resolution" definitions if not already present. Update "Model Discovery" to mention normalization pipeline.

**Check If Affected:**

- `packages/pi-cursor/README.md` — Update model selection documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Normalized model list has no duplicate entries for effort variants
- [ ] Pi's reasoning-effort setting correctly selects the Cursor effort variant
- [ ] `modelMappings=raw` bypasses normalization entirely
- [ ] Max mode flag handled separately from max effort suffix
- [ ] Fallback models JSON exists for pre-login

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-006): complete Step N — description`
- **Bug fixes:** `fix(TP-006): description`
- **Tests:** `test(TP-006): description`
- **Hydration:** `hydrate: TP-006 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Persist normalization data as config — it's derived at runtime from model discovery
- Set non-zero cost metadata — Cursor is subscription-based
- Implement the `/cursor` command — that's TP-010

---

## Amendments (Added During Execution)
