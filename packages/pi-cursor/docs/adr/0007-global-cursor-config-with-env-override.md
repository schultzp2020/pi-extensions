# Global cursor config file with environment variable override

User settings for the Cursor provider are stored in `~/.pi/agent/cursor-config.json`, a versioned JSON file owned by the extension. Environment variables override file values, which override built-in defaults.

## Schema (v1)

```json
{
  "version": 1,
  "nativeToolsMode": "reject",
  "maxMode": false,
  "modelMappings": "normalized",
  "maxRetries": 2
}
```

Only explicit user settings are stored. Model normalization data, cached models, and derived state are never persisted as config.

## Precedence

1. Environment variables (`PI_CURSOR_NATIVE_TOOLS_MODE`, `PI_CURSOR_MAX_MODE`, `PI_CURSOR_RAW_MODELS`, `PI_CURSOR_MAX_RETRIES`)
2. `cursor-config.json`
3. Built-in defaults

## Resilience

- Invalid JSON or malformed values → fall back to defaults, ignore bad fields
- Unknown fields → ignored (forward compatibility)
- Missing file → use defaults, create on first `/cursor` save

## Considered Options

- **A: Pi's built-in settings** — Pi has no global settings store for extensions. `pi.appendEntry()` is session-scoped.
- **B: Environment variables only** — No persistence across sessions without shell profile editing.
- **C: Config file + env override** — Persistent defaults with temporary override capability.

## Decision

Option C. The `/cursor` command edits the config file. Environment overrides are shown in the menu when active but cannot be changed via the UI (they override the persisted value for the current process).

## Consequences

- Settings are global across all Pi sessions sharing the same `~/.pi/agent/` directory.
- Changes affect only new requests, not in-flight sessions.
- Version field enables safe schema migration in future releases.
