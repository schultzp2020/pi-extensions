---
'@schultzp2020/pi-cursor': minor
---

### Proxy architecture deepening

**Breaking changes:**

- **`modelMappings` config removed** — The `modelMappings` setting (`normalized` | `raw`) and its env override `PI_CURSOR_RAW_MODELS` no longer exist. Models are always normalized; the raw pass-through mode has been removed. Delete `modelMappings` from `cursor-config.json` and unset `PI_CURSOR_RAW_MODELS` if used.

- **`CursorConfig` shape changed** — `modelMappings: ModelMappingsMode` replaced by two new fields:
  - `fast: boolean` (default: `false`) — send fast-mode suffix to Cursor
  - `thinking: boolean` (default: `true`) — send thinking suffix to Cursor

- **Environment variables changed:**
  - Removed: `PI_CURSOR_RAW_MODELS`
  - Added: `PI_CURSOR_FAST`, `PI_CURSOR_THINKING`

- **`ProxyContext.config` type changed** — now `Pick<CursorConfig, 'nativeToolsMode' | 'maxMode' | 'fast' | 'thinking' | 'maxRetries'>` (was an inline object type with `modelMappings`).

- **`resolveModelId` signature changed** — now takes 5 arguments `(modelId, effort, fast, thinking, modelSet)` instead of 4 `(modelId, effort, maxMode, modelSet)`.

- **Model normalization internals reworked:**
  - `ParsedModelId` → `ParsedSlug`, `FamilyMeta` → `ModelMeta`
  - `parseModelId()` → `parseSlug()` (parses legacy slugs, not model IDs)
  - `familyKey()` removed — effort maps now keyed by model ID directly
  - `NormalizedModelSet.families` → `NormalizedModelSet.modelMeta`

- **`GetUsableModels` fallback removed** — model discovery now uses only the `AvailableModels` RPC. The `GetUsableModels` agent.v1 fallback path has been deleted.

- **`ModelMappingsMode` type removed** — no longer exported from `config.ts`.

**New features:**

- **Per-model `thinkingLevelMap`** — models with effort maps now expose `thinkingLevelMap` to Pi core, enabling the reasoning-effort selector and level cycling per model.
- **Per-model context window tiers** — `CursorModel` now stores both `contextWindow` and `contextWindowMaxMode` from the API. Models with a larger tier are registered as additional entries in the model picker (e.g. "GPT-5.4 [1M]") with the actual context size in the name. Context tiers are fully dynamic from Cursor's API.
- **`RequestedModel` in agent requests** — the proxy now sends the new `RequestedModel` protobuf field alongside the deprecated `ModelDetails`, with support for model parameters (e.g. long context).
- **`/cursor` menu reordered** — settings now appear as: Max Mode, Fast, Thinking, Native Tools Mode, Max Retries.
- **`PI_CURSOR_CAPTURE_PARAMS=1`** — dumps raw Cursor API responses (including `contextTokenLimit` and `contextTokenLimitForMaxMode` per model) to `~/.pi/agent/cursor-captures/` during model discovery.
- **Legacy slug resolution** — models with `legacySlugs` from Cursor's API are parsed to determine effort levels, fast support, and thinking support per model, with a slug lookup table for request-time resolution.
- **Fallback models updated** — synced with Cursor AvailableModels API (2026-05-07), using new normalized IDs (e.g. `claude-sonnet-4-6` instead of `claude-4.6-sonnet`).
