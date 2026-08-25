# Model normalization with effort mapping controlled by modelMappings setting

Raw Cursor model IDs encode effort level, speed variant, and thinking mode as suffixes (e.g. `gpt-5.4-high-fast`, `claude-4.6-opus-max-thinking`). These are collapsed into deduplicated Pi-visible models with Pi's reasoning-effort setting controlling the actual variant sent to Cursor.

## How it works

Each legacy slug is parsed by popping trailing `-fast`, `-thinking`, and effort segments (`minimal`, `none`, `low`, `medium`, `high`, `extra-high`, `xhigh`, `max`) in any order. Max Mode stays a separate request-time suffix from the global setting; it is not stripped during slug parse.

Critical: `-max` has **three** meanings in Cursor model IDs:

- **Trailing `-max` on the wire** → maxMode flag (appended at request time when Max Mode is on)
- **Effort suffix `max`** → an effort level (e.g. `claude-4.6-opus-max` = effort `max` on base `claude-4.6-opus`)
- **Base name component** → part of model identity (e.g. `gpt-5.1-codex-max` = a distinct model family)

Cursor lists preferred slugs before compatibility aliases. First-wins keeps that preferred slug.

Models sharing the same `(base, variant)` with multiple effort levels or a single non-empty effort suffix are collapsed into one entry with `compat.supportsReasoningEffort: true`. The selector `thinkingLevelMap` is the **family-union** effort map so Pi keeps levels such as `xhigh` selectable. Request-time resolve uses **per-variant** effort sets.

Pi's effort levels map to Cursor suffixes via `buildEffortMap`:

- `minimal` → `minimal` if available, then `none`, then `low`
- `low` → `low` if available, then `none`, then `minimal`
- `medium` → `medium` or no suffix (default)
- `high` → `high` if available, else the highest lower effort
- `xhigh` → `max` if available, then `xhigh`, then `extra-high`, then `high`

`xhigh` and `max` effort suffixes **can coexist** in the same family (e.g. `gpt-5.2` has `{low, high, xhigh, max}`). When both exist, `max` is the higher effort and maps to Pi's `xhigh`.

If the selected thinking/fast variant has no preferred match for a named Pi effort, resolve tries the next flag candidate instead of remapping that effort (so `low`+thinking on a sparse thinking family stays `low`; an effort-less thinking slug such as Haiku still keeps thinking).

At request time the proxy reconstructs the full Cursor model ID from the resolved legacy slug, then appends maxMode (`-max`) if the global Max Mode setting is on and the family supports it.

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
