# PRD: `/cursor` Settings, Model Normalization, and Session Correctness

## Problem Statement

The pi-cursor extension exposes Cursor subscription models to Pi but has several gaps that hurt usability, correctness, and debuggability:

1. **No user-facing settings.** Native tool behavior, max mode, and model mapping are hardcoded. Users cannot configure the extension without editing source code.

2. **Model list is overwhelming.** Cursor exposes 169+ raw model variants encoding effort level, speed, thinking mode, and max capability in the model ID. Pi's `/model` picker shows all of them, making model selection tedious and confusing.

3. **Sessions break after compaction.** Conversation keys are derived from message content. When Pi compacts the session (replacing history with a summary), the keys change, orphaning all stored state — checkpoints, blob stores, active bridges. The conversation dies.

4. **Fork/branch navigation silently corrupts state.** There is no checkpoint lineage validation. Stale checkpoints are reused after forks, producing garbled Cursor responses.

5. **Retry is unwired.** The proxy can detect retryable failures and signals `outcome: 'retry'`, but never actually retries. Transient Cursor errors kill the conversation.

6. **Image-capable models don't work with images.** Models advertise image input support, but `openai-messages.ts` drops image content parts.

7. **No debug tooling.** When things go wrong, there is no structured logging or timeline tool to diagnose what happened.

8. **Native tool policy is implicit.** The extension always redirects overlapping native tools through Pi equivalents with no way to use Cursor's tools directly or reject them entirely.

## Solution

Ship a cohesive feature set that adds a `/cursor` settings command, persistent global config, model normalization with reasoning-effort mapping, correct session identity, checkpoint safety, retry execution, image bridging, configurable native-tool modes, and structured debug logging.

After this change:

- Users run `/cursor` to configure the extension (native tools mode, max mode, model mappings, retry count)
- The model picker shows deduplicated models; Pi's reasoning-effort setting controls the underlying Cursor variant
- Sessions survive compaction, forks, and branch navigation
- Transient Cursor errors are retried automatically
- Images work with image-capable models
- Debug logging can be enabled with an environment variable

## User Stories

1. As a Pi user, I want to run `/cursor` and see a settings menu, so that I can configure the extension without editing code.
2. As a Pi user, I want to change `nativeToolsMode` to `reject` so that only Pi's explicit tools are available and Cursor's native tools don't interfere.
3. As a Pi user, I want to change `nativeToolsMode` to `native` so that Cursor's built-in tools execute locally for lower latency.
4. As a Pi user, I want to change `nativeToolsMode` to `redirect` so that Cursor's overlapping tools transparently use Pi's implementations.
5. As a Pi user, I want to toggle `maxMode` on so that my selected model uses Cursor's highest-capability variant when available.
6. As a Pi user, I want `maxMode` to be silently ignored when my selected model has no max variant, so I don't have to think about per-model compatibility.
7. As a Pi user, I want the model picker to show deduplicated models (e.g. one `gpt-5.4` instead of six effort variants), so model selection is not overwhelming.
8. As a Pi user, I want Pi's reasoning-effort setting (minimal/low/medium/high/xhigh) to automatically select the right Cursor effort variant, so I don't have to manually pick effort-suffixed model IDs.
9. As a Pi user, I want to set `modelMappings` to `raw` to see all original Cursor model variants when I need to debug or pick a specific variant.
10. As a Pi user, I want switching `modelMappings` to immediately update the model picker without restarting Pi.
11. As a Pi user, I want my `/cursor` settings to persist across Pi sessions, so I don't have to reconfigure every time.
12. As a Pi user, I want to override settings temporarily via environment variables (e.g. `PI_CURSOR_RAW_MODELS=1`) without changing my persisted config.
13. As a Pi user, I want conversations to survive session compaction, so I can use long sessions without Cursor losing context.
14. As a Pi user, I want fork/branch navigation to correctly invalidate stale state, so I don't get garbled responses after navigating the session tree.
15. As a Pi user, I want transient Cursor errors to be retried automatically, so temporary failures don't kill my conversation.
16. As a Pi user, I want to configure the maximum number of retries via `/cursor`.
17. As a Pi user, I want image content to work with image-capable Cursor models, so I can send screenshots and diagrams.
18. As a Pi user, I want to enable debug logging with `PI_CURSOR_PROVIDER_DEBUG=1` to diagnose issues.
19. As a Pi user, I want a timeline script that summarizes debug logs into a human-readable format.
20. As a developer, I want the proxy to send an explicit cancel action to Cursor on client disconnect, so Cursor doesn't waste resources on abandoned turns.
21. As a developer, I want checkpoints to only be committed after successful turn completion, so interrupted turns don't corrupt state.
22. As a developer, I want session cleanup to happen on Pi lifecycle events (switch, fork, tree, shutdown), so proxy state doesn't leak across sessions.
23. As a Pi user, I want native tools in `native` mode to be sandboxed to my project's git root, so the proxy can't accidentally access files outside my workspace.
24. As a Pi user, I want settings changes to take effect on new requests without affecting in-flight conversations.
25. As a Pi user, I want the `/cursor` menu to show when a setting is overridden by an environment variable.

## Implementation Decisions

### Config system

- Global config file at `~/.pi/agent/cursor-config.json` with `version` field (starting at 1)
- Stores only explicit user settings: `nativeToolsMode`, `maxMode`, `modelMappings`, `maxRetries`
- Precedence: environment variables > config file > built-in defaults
- Defaults: `nativeToolsMode=reject`, `maxMode=false`, `modelMappings=normalized`, `maxRetries=2`
- Invalid/malformed files fall back to defaults; unknown fields are ignored

### `/cursor` command

- Single-level settings menu via `pi.registerCommand()` and `ctx.ui.select()`
- Each row opens a second selector of valid values
- Settings persist immediately on change
- `maxMode` row is hidden/disabled when `modelMappings=raw`
- Shows environment override indicators when applicable

### Model normalization

- Parser strips suffixes in order: trailing `-max` (maxMode flag), `-fast`, `-thinking`, then effort from last segment
- Three meanings of `max`: trailing maxMode flag, effort level, base name component — all independent and composable
- `xhigh` and `max` effort suffixes can coexist in the same family; when both exist, `max` is higher and maps to Pi's `xhigh`
- Extension owns the visible model list and provider compat metadata
- Proxy owns final raw Cursor model resolution at request time
- Switching `modelMappings` triggers immediate provider re-registration with best-match model preservation
- Normalization data is derived at runtime from model discovery, never persisted as config
- Cost metadata stays at zero (subscription model)

### Effort mapping

- Pi levels map to Cursor suffixes via `buildEffortMap` using the family's available effort set
- `minimal` → `none` or `low`; `low` → `low`; `medium` → `medium` or no suffix; `high` → `high`; `xhigh` → `max` or `xhigh` or `high`
- Registered via provider `compat.supportsReasoningEffort` and `compat.reasoningEffortMap`

### Native tools modes

- `reject` (default, breaking change from previous implicit redirect): all native Cursor tools rejected
- `redirect`: overlapping tools (read, write, delete, shell, shellStream, ls, grep, fetch) executed through Pi equivalents; remaining Cursor tools rejected
- `native`: overlapping tools executed as true proxy-local operations sandboxed to nearest git root of `ctx.cwd`; Allowed Root captured per session; shell inherits normal process environment; `mcp_pi_*` preference guidance removed from prompt
- Mode-dependent prompt guidance in `request-context.ts`
- Unsupported remaining tools reject clearly in all modes

### Session identity

- Real Pi session ID injected via `before_provider_request` hook as `pi_session_id` in request body
- All session/conversation/bridge keys derived from stable session ID
- Lifecycle cleanup on `session_before_switch`, `session_before_fork`, `session_before_tree`, `session_shutdown`

### Checkpoint safety

- Lineage metadata: completed turn count + SHA256 fingerprint of completed structured history
- Validate on every request; discard checkpoint on mismatch (fork, compaction, branch navigation)
- Checkpoints committed only after successful turn completion
- Explicit `CancelAction` protobuf sent to Cursor on client disconnect
- Previous committed checkpoint preserved on interruption

### Protobuf improvements

- Content-addressed blob store with SHA256 IDs
- Richer `ConversationStateStructure` fields: `rootPromptMessagesJson`, `previousWorkspaceUris`, `mode`, `clientName`
- Full structured turn reconstruction: tool calls, tool results, post-tool assistant text
- Deterministic conversation IDs derived from conversation key
- Partial tool result resume (re-emit pending tool calls when not all results are back)

### Retry

- Proxy executes retries up to `maxRetries` (default 2) on retryable Cursor failures
- Configurable via `/cursor` and `PI_CURSOR_MAX_RETRIES` env var

### Image bridging

- `openai-messages.ts` preserves and bridges image content parts to Cursor's protobuf format

### Debug tooling

- `PI_CURSOR_PROVIDER_DEBUG=1` enables structured JSONL logging
- Extension-level hooks on `message_start`, `message_update`, `message_end`, `context`, `turn_end`
- Proxy-level event logging with request/session IDs
- `scripts/debug-log-timeline.mjs` for human-readable log summaries
- Log file path configurable via `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`

### Fallback models

- Static `cursor-models-raw.json` file for pre-login model availability

## Testing Decisions

Good tests for this feature set test **external behavior through module interfaces**, not internal implementation details. They should be deterministic, fast, and not require network access or a real Cursor subscription.

### Modules to test

- **Model normalization** (`parseModelId`, `processModels`, `buildEffortMap`, `resolveModelId`, `supportsReasoningModelId`) — pure functions, high value. Port and extend the upstream test suite. Cover edge cases: triple-max model IDs, xhigh+max coexistence, single-effort collapse, codex-max base names.
- **Config** (`loadConfig`, `saveConfig`, `resolveEffective`) — env override precedence, version migration, malformed file handling, unknown fields.
- **Checkpoint lineage** (`computeLineageFingerprint`, `validateLineage`, `shouldDiscardCheckpoint`) — turn count mismatch, fingerprint mismatch, same-depth fork, compaction scenario.
- **Native tool execution** — path sandboxing enforcement, allowed-root boundary, each tool's execute+format cycle.
- **Native tools routing** — mode-aware dispatch for all three modes (extend existing `tool-gating.test.ts` and `native-tools.test.ts`).
- **Message parsing** — image content part preservation (extend existing `openai-messages.test.ts`).

### Prior art

- `packages/pi-cursor/src/proxy/tool-gating.test.ts` — comprehensive exec message routing tests
- `packages/pi-cursor/src/proxy/native-tools.test.ts` — tool classification and enabled-set tests
- `packages/pi-cursor/src/proxy/openai-messages.test.ts` — message parsing tests
- `packages/pi-cursor/src/proxy/conversation-state.test.ts` — state persistence tests

## Out of Scope

- Per-token cost tracking (Cursor is subscription-based; zeros are honest)
- Periodic model refresh polling (explicit action or restart only)
- Implementation of all remaining Cursor tools (`backgroundShellSpawn`, `webSearch`, `exaSearch`, `askQuestion`, `switchMode`, `createPlan`) — these reject clearly for now
- Nested/hierarchical settings menus
- Per-session or per-project config overrides (config is global only)
- Conversation state persistence to disk across proxy restarts (checkpoints are in-memory with disk cache; full durability is a separate concern)

## Further Notes

- This is a **breaking change**: default `nativeToolsMode` shifts from implicit redirect to explicit `reject`. Acceptable pre-1.0.
- The upstream repo ([ndraiman/pi-cursor-provider](https://github.com/ndraiman/pi-cursor-provider)) has a stale fallback model file (83 models vs 169+ in real Cursor data). The real data reveals that `xhigh` and `max` effort suffixes coexist and that trailing `-max` is a universal maxMode flag, not an effort level.
- Session compaction breakage is the most user-visible bug fixed by this work. The root cause is content-based key derivation; the fix is session-ID-based key derivation.
