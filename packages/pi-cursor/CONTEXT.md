# pi-cursor

A Pi extension that provides access to Cursor subscription models (Composer, Claude, GPT, Gemini, etc.) inside Pi via a local OpenAI-compatible proxy.

## Language

**Proxy**:
A local Node.js HTTP server that translates OpenAI-format requests into Cursor's gRPC/protobuf protocol and streams responses back as OpenAI SSE. Shared across multiple Pi sessions.
_Avoid_: bridge, server, gateway

**Bridge**:
A single HTTP/2 connection to Cursor's gRPC endpoint (`api2.cursor.sh`) that carries one conversation turn. Kept alive across tool-call round-trips within a single turn. Auto-resumes from Checkpoint on transient failures.
_Avoid_: connection, stream, session

**Internal API**:
HTTP endpoints on the Proxy (`/internal/heartbeat`, `/internal/token`, `/internal/refresh-models`, `/internal/health`, `/internal/cleanup-session`) used by all connected extension instances for ongoing communication — heartbeats, token delivery, model refresh, and session cleanup.
_Avoid_: control API, management API, stdin protocol

**Stdout Protocol**:
A JSON-lines protocol over stdout from the Proxy to the spawning extension, used only during initial startup to communicate the port and model list. Closed after startup.
_Avoid_: control channel, IPC

**Port File**:
A JSON file at `~/.pi/agent/cursor-proxy.json` containing the Proxy's port and PID. Written by the spawning extension, read by subsequent extension instances to discover an existing Proxy.
_Avoid_: lock file, discovery file

**Session ID**:
The real Pi session ID, injected into every request via the `pi_session_id` field in the request body using a `before_provider_request` hook. Used to isolate Bridges, Checkpoints, and Blob Stores between different Pi sessions sharing the same Proxy.
_Avoid_: session key, session token, X-Session-Id header

**Model Discovery**:
A gRPC call to Cursor's `AvailableModels` or `GetUsableModels` endpoint that returns all models the user's subscription can access. Performed once on Proxy startup, and again on demand via the Internal API or `/cursor` command. When `modelMappings=normalized`, discovered models pass through the Model Normalization pipeline (`processModels`) before being registered with Pi.
_Avoid_: model fetch, model sync

**Model Cache**:
A JSON file on disk containing the last successful Model Discovery result. Used on startup to register models immediately, then refreshed in the background.
_Avoid_: model list, model registry

**Fallback Models**:
A static model list (`fallback-models.ts`) bundled with the extension containing a snapshot of known Cursor model IDs. Used to register models before login when no Model Cache exists. Also available as `cursor-models-raw.json` for reference.
_Avoid_: default models, hardcoded models

**Model Normalization**:
The process of collapsing raw Cursor model variants into deduplicated Pi-visible models. Raw IDs encode up to four dimensions: effort level, speed (`-fast`), thinking (`-thinking`), and maxMode (trailing `-max`). Parsing strips suffixes in order: trailing `-max` first, then `-fast`, then `-thinking`, then effort from the last remaining segment. Controlled by the `modelMappings` setting.
_Avoid_: model dedup, model collapse

**Effort Map**:
A per-model mapping from Pi's reasoning-effort levels (`minimal`, `low`, `medium`, `high`, `xhigh`) to the best available Cursor effort suffix for that family. Built dynamically from the family's actual effort set using `buildEffortMap`. In current Cursor data, `xhigh` and `max` are mutually exclusive per family — GPT-style models use `xhigh`, Claude-style models use `max`. Registered via the provider's `reasoningEffortMap` compat field when a model `supportsReasoningEffort`.
_Avoid_: effort table, reasoning map

**Effort Resolution**:
The process of reconstructing the final Cursor model ID at request time by inserting the mapped effort suffix before any `-fast` or `-thinking` variant suffix. Performed by the Proxy using the Effort Map and global settings.
_Avoid_: model resolution, effort insertion

**Max Mode**:
A global setting (`maxMode`) that appends a trailing `-max` suffix to the final Cursor model ID, activating Cursor's max capability mode. Best-effort — silently ignored if the model family has no max variant. Separate from the `max` effort suffix, which is one of Cursor's effort levels that can appear in both Claude-style and GPT-style families and maps to Pi's `xhigh` reasoning level. Also distinct from `max` appearing in a base model name (e.g. `gpt-5.1-codex-max`), which is part of the model identity. All three meanings of `max` are independent and can compose: `claude-4.6-opus-max-thinking-fast-max` has effort `max`, thinking variant, fast variant, and maxMode flag.
_Avoid_: max effort, max variant (when referring to the global toggle)

**Proxy Reconnect**:
The process of a newly loaded extension instance reconnecting to an existing Proxy that survived a reload or session switch. Uses the Port File for discovery across sessions, and `pi.appendEntry()` for fast reconnect within the same session during `/reload`.
_Avoid_: rediscovery, reattach

**Checkpoint**:
A protobuf snapshot of conversation state that Cursor's server sends after significant state changes. Persisted to disk so sessions survive Proxy restarts. Committed only after a turn completes successfully — never on interruption or client disconnect.
_Avoid_: state, snapshot, save

**Checkpoint Lineage**:
Metadata stored alongside the latest committed Checkpoint: completed turn count and a fingerprint of the completed structured history. Used to detect stale Checkpoints after forks, compaction, or branch navigation.
_Avoid_: checkpoint history, checkpoint version

**Blob Store**:
A content-addressed key-value store of binary data (system prompts, user messages, conversation turns) using SHA256-based IDs. Cursor's server requests blobs back via KV handshake messages. Persisted to disk alongside Checkpoints.
_Avoid_: cache, KV store

**Native Tools Mode**:
A global setting (`nativeToolsMode`) controlling how Cursor's built-in tool calls are handled. Three modes:

- **`reject`** (default): All native Cursor tool calls are rejected. Only explicit MCP/Pi tools succeed.
- **`redirect`**: Overlapping native tools are transparently executed through Pi equivalents. Remaining Cursor tools stay available.
- **`native`**: Overlapping tools are executed as true proxy-local operations (sandboxed to the nearest git root of `ctx.cwd`). Non-overlapping Pi MCP tools remain available but the "prefer mcp*pi*\*" prompt guidance is removed.
  _Avoid_: tool policy, tool mode

**Overlapping Tools**:
The set of Cursor native tools that have direct Pi equivalents: `readArgs`, `writeArgs`, `deleteArgs`, `shellArgs`, `shellStreamArgs`, `lsArgs`, `grepArgs`, `fetchArgs`. These are the tools affected by the `redirect` and `native` modes.
_Avoid_: mapped tools, redirectable tools

**Remaining Tools**:
Cursor native tools with no Pi equivalent: `backgroundShellSpawnArgs`, `writeShellStdinArgs`, `diagnosticsArgs`, `webSearchRequestQuery`, `exaSearchRequestQuery`, `exaFetchRequestQuery`, `askQuestionInteractionQuery`, `switchModeRequestQuery`, `createPlanRequestQuery`. These are rejected in `reject` mode and passthrough/rejected in `native`/`redirect` modes depending on implementation status.
_Avoid_: unmapped tools, unsupported tools

**Tool Gating**:
Filtering every MCP passthrough, native redirect, and implicit Cursor interaction feature against the tool set Pi explicitly registered for the session. Unenabled tools return explicit rejection or `isError: true` responses so the model falls back to the tools Pi actually allowed.
_Avoid_: tool allowlist, permission layer, tool ACL

**Allowed Root**:
The filesystem boundary for proxy-local native tool execution in `native` mode. Captured once per session from the nearest git root containing `ctx.cwd`, falling back to `ctx.cwd` if no git repo is found. Paths outside this root are rejected.
_Avoid_: workspace root, sandbox root

**MCP Tool**:
A tool definition registered via Cursor's `RequestContext` that the model uses as a fallback when no native tool redirection applies. These map 1:1 to Pi's tool definitions.
_Avoid_: external tool, custom tool

**Cloud Rule**:
A text field in Cursor's `RequestContext` protobuf message used to deliver system-level instructions that the model respects. Used instead of the `system` role, which Cursor ignores. Prompt guidance varies by Native Tools Mode.
_Avoid_: system prompt, system message, rules

**Cursor Config**:
A global JSON file at `~/.pi/agent/cursor-config.json` containing explicit user settings: `nativeToolsMode`, `maxMode`, `modelMappings`, `maxRetries`. Versioned with a `version` field. Environment variables override config file values, which override built-in defaults.
_Avoid_: settings file, preferences

**`/cursor` Command**:
A Pi command that opens a single-level settings menu. Each row opens a second selector of valid values. Settings persist to the Cursor Config file and take effect on new requests.
_Avoid_: cursor settings, config command

**Debug Logger**:
A structured JSONL debug logger gated behind `PI_CURSOR_PROVIDER_DEBUG=1`. When enabled, appends one JSON object per line to `~/.pi/agent/cursor-debug.jsonl` (configurable via `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`). When disabled, all log functions are zero-cost no-ops. Logs event types: `request_start`, `request_end`, `session_create`, `session_resume`, `checkpoint_commit`, `checkpoint_discard`, `retry`, `tool_call`, `bridge_open`, `bridge_close`, `lifecycle`. Each entry includes `timestamp` (ISO 8601), `type`, `sessionId`, `requestId`, and type-specific payload. A companion timeline script (`scripts/debug-log-timeline.mjs`) transforms JSONL logs into human-readable timelines grouped by request, with `--session`, `--since`, and `--until` filtering.
_Avoid_: debug mode, verbose mode, trace

## Image Bridging

The message parsing layer (`openai-messages.ts`) preserves image content parts from OpenAI-format requests. When a user sends `image_url` content parts (screenshots, diagrams), `extractImageParts()` extracts them and `parseMessages()` carries them through as `ImagePart[]` on both `ParsedMessages.images` (current turn) and `ParsedConversationTurn.images` (history turns). The `textContent()` function continues to return text only — images are a separate channel. Downstream consumers (e.g., `cursor-session.ts`) can access parsed images to encode them into Cursor's protobuf format.

## Relationships

- The **Proxy** spawns one or more **Bridges** to handle concurrent requests, isolated by **Session ID**
- A **Bridge** translates tool calls according to the current **Native Tools Mode**: reject, redirect through Pi, or execute locally within the **Allowed Root**
- A **Bridge** translates **MCP Tool** calls into OpenAI `tool_calls` for Pi, with results sent back as MCP protobuf
- The **Proxy** persists **Checkpoints**, **Checkpoint Lineage**, and **Blob Store** data to disk, keyed by **Session ID** + conversation
- The **Proxy** validates **Checkpoint Lineage** on every request — discards stale Checkpoints on fork, compaction, or branch navigation
- The **Proxy** exposes the **Internal API** for heartbeats, token delivery, model refresh, and **Lifecycle Cleanup**
- Extension instances discover the **Proxy** via the **Port File**, or spawn a new one if none exists
- **Model Discovery** results are cached to disk as the **Model Cache** for fast subsequent startups
- **Model Normalization** collapses raw Cursor variants into deduplicated models with **Effort Maps**
- **Effort Resolution** combines the normalized model, **Max Mode**, and Pi's reasoning-effort setting to reconstruct the final Cursor model ID
- The **`/cursor` Command** edits the **Cursor Config** and triggers provider re-registration when **Model Normalization** mode changes
- **Lifecycle Cleanup** hooks (`session_before_switch`, `session_before_fork`, `session_before_tree`, `session_shutdown`) call the Internal API to close active Bridges and evict state before session transitions
- On client disconnect, the Proxy sends a **CancelAction** protobuf to Cursor and suppresses pending Checkpoint commits to preserve the last committed state
- The **Debug Logger** records structured events from both the Proxy (request lifecycle, sessions, checkpoints) and the extension (lifecycle hooks), output to JSONL when `PI_CURSOR_PROVIDER_DEBUG=1`

## Example dialogue

> **Dev:** "When a second Pi session starts, does it spawn its own Proxy?"
> **Domain expert:** "No — it reads the Port File, finds the existing Proxy, verifies the PID, and starts heartbeating via the Internal API. Each session's requests are isolated by Session ID."

> **Dev:** "What happens when Cursor's model tries to use its native `read` tool?"
> **Domain expert:** "That depends on the Native Tools Mode. In `reject` mode (the default), it's rejected with an error message. In `redirect` mode, it's translated to Pi's `read` tool. In `native` mode, the Proxy reads the file directly within the Allowed Root."

> **Dev:** "How does the model list differ from what Cursor shows?"
> **Domain expert:** "When `modelMappings` is `normalized` (the default), effort-level variants are collapsed. So `gpt-5.4-low`, `gpt-5.4-medium`, `gpt-5.4-high` become a single `gpt-5.4` entry with Pi's reasoning-effort setting controlling the actual variant. Set `modelMappings` to `raw` or `PI_CURSOR_RAW_MODELS=1` to see all raw variants."

> **Dev:** "What happens after session compaction?"
> **Domain expert:** "The Proxy derives conversation keys from the stable Pi Session ID, not from message content. After compaction the history changes but the session ID stays the same, so the Proxy finds the right conversation state. The Checkpoint Lineage detects that the history fingerprint no longer matches and discards the stale checkpoint, then reconstructs turns from the compacted history."

## Flagged ambiguities

- "bridge" in the opencode-cursor reference means both "the H2 connection" and "the Node child process that wraps it." Here, **Bridge** means the H2 connection only — the child process wrapper is eliminated because Pi runs on Node.js natively.
- "cost" — Pi tracks per-model costs in $/million tokens. Cursor models report **zero cost** because the user pays via their Cursor subscription, not per-token through this extension. Token counts (input/output/cache) are still tracked.
- "heartbeat" — Two different heartbeats exist: the extension→Proxy heartbeat via Internal API (proves sessions are alive), and the Proxy→Cursor heartbeat on the H2 stream (keeps the Bridge alive). Context makes the distinction clear.
- "max" — Overloaded three ways. **Trailing `-max` suffix** is the maxMode flag (stripped first during parsing, controlled by global Max Mode setting). **Effort suffix `max`** is one of Cursor's effort levels that can coexist with `xhigh` in the same family, mapped to Pi's `xhigh` reasoning level. **Base name `max`** (e.g. `gpt-5.1-codex-max`) is part of the model identity. All three are independent and can compose in a single model ID (e.g. `claude-4.6-opus-max-thinking-fast-max` = base `claude-4.6-opus`, effort `max`, thinking, fast, maxMode on).
- "native" — In the Native Tools Mode context, "native" means Cursor's built-in tools executed as true proxy-local operations. Not to be confused with Pi's native tools.
