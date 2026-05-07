# Model normalization with effort mapping controlled by modelMappings setting

Raw Cursor model IDs encode effort level, speed variant, and thinking mode as suffixes (e.g. `gpt-5.4-high-fast`, `claude-4.6-opus-max-thinking`). These are collapsed into deduplicated Pi-visible models with Pi's reasoning-effort setting controlling the actual variant sent to Cursor.

## How it works

Each raw Cursor model ID is parsed in order:

1. Strip trailing `-max` → this is the **maxMode flag** (Cursor's max capability toggle), not an effort level
2. Strip `-fast` → speed variant
3. Strip `-thinking` → thinking variant
4. Parse the last remaining segment for effort (`none`, `low`, `medium`, `high`, `xhigh`, `max`)

This produces: `{base}[-{effort}][-thinking][-fast][-max(mode)]`

Critical: `-max` has **three** meanings in Cursor model IDs:

- **Trailing `-max`** → maxMode flag (stripped first, controlled by global Max Mode setting)
- **Effort suffix `max`** → an effort level (e.g. `claude-4.6-opus-max` = effort `max` on base `claude-4.6-opus`)
- **Base name component** → part of model identity (e.g. `gpt-5.1-codex-max` = a distinct model family)

Models like `claude-4.6-opus-max-thinking-fast-max` have both effort `max` AND maxMode flag.

Models sharing the same `(base, variant)` with multiple effort levels or a single non-empty effort suffix are collapsed into one entry with `compat.supportsReasoningEffort: true` and a model-level `thinkingLevelMap` built from the family's effort map.

Pi's effort levels map to Cursor suffixes via `buildEffortMap`, which picks the best available match from the family's actual effort set:

- `minimal` → `none` if available, else `low`, else lowest available
- `low` → `low`
- `medium` → `medium` or no suffix (default)
- `high` → `high`
- `xhigh` → `max` if available, else `xhigh`, else `high`

`xhigh` and `max` effort suffixes **can coexist** in the same family (e.g. `gpt-5.2` has `{low, high, xhigh, max}`). When both exist, `max` is the higher effort and maps to Pi's `xhigh`.

At request time the proxy reconstructs the full Cursor model ID: `base` + effort suffix + variant suffixes (`-thinking`/`-fast`) + maxMode suffix (`-max` if global Max Mode is on and the family supports it).

## `modelMappings` setting

- **`normalized`** (default) — Deduplicated model list, effort controlled by Pi.
- **`raw`** — All raw Cursor variants exposed directly. Max Mode setting is hidden/disabled.

Overridable via `PI_CURSOR_RAW_MODELS=1` environment variable.

## Max Mode interaction

Max Mode is a separate global toggle. When enabled, the proxy requests the max-capability variant if one exists in the family. When `modelMappings=raw`, Max Mode is hidden because users can select raw `*-max` variants directly.

## Considered Options

- **A: Expose all raw variants** — Simple, but 83+ models overwhelm the picker and duplicate the same model 4-6x.
- **B: Always deduplicate** — Clean picker, but no escape hatch for debugging or edge cases.
- **C: Configurable via `modelMappings`** — Clean default with a debug/power-user escape hatch.

## Decision

Option C. Normalization data is derived at runtime from model discovery, never persisted as config.

## Consequences

- Switching `modelMappings` triggers immediate provider re-registration.
- Current model is preserved via best-match reconstruction from effective settings.
- Cost metadata stays at zero (subscription model, no per-token costs).
- Fallback models JSON provides a pre-login model list.
