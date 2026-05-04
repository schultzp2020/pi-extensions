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
HTTP endpoints on the Proxy (`/internal/heartbeat`, `/internal/token`, `/internal/refresh-models`, `/internal/health`) used by all connected extension instances for ongoing communication — heartbeats, token delivery, and model refresh.
_Avoid_: control API, management API, stdin protocol

**Stdout Protocol**:
A JSON-lines protocol over stdout from the Proxy to the spawning extension, used only during initial startup to communicate the port and model list. Closed after startup.
_Avoid_: control channel, IPC

**Port File**:
A JSON file at `~/.pi/agent/cursor-proxy.json` containing the Proxy's port and PID. Written by the spawning extension, read by subsequent extension instances to discover an existing Proxy.
_Avoid_: lock file, discovery file

**Session ID**:
A unique identifier sent via `X-Session-Id` header with every request to the Proxy. Used to isolate Bridges, Checkpoints, and Blob Stores between different Pi sessions sharing the same Proxy.
_Avoid_: session key, session token

**Model Discovery**:
A gRPC call to Cursor's `GetUsableModels` endpoint that returns all models the user's subscription can access. Performed once on Proxy startup, and again on demand via the Internal API.
_Avoid_: model fetch, model sync

**Model Cache**:
A JSON file on disk containing the last successful Model Discovery result. Used on startup to register models immediately, then refreshed in the background.
_Avoid_: model list, model registry

**Proxy Reconnect**:
The process of a newly loaded extension instance reconnecting to an existing Proxy that survived a reload or session switch. Uses the Port File for discovery across sessions, and `pi.appendEntry()` for fast reconnect within the same session during `/reload`.
_Avoid_: rediscovery, reattach

**Checkpoint**:
A protobuf snapshot of conversation state that Cursor's server sends after significant state changes. Persisted to disk so sessions survive Proxy restarts.
_Avoid_: state, snapshot, save

**Blob Store**:
A key-value store of binary data (system prompts, conversation chunks) that Cursor's server requests back via KV handshake messages. Persisted to disk alongside Checkpoints.
_Avoid_: cache, KV store

**Native Tool Redirection**:
Intercepting Cursor's built-in tool calls and translating them to Pi's equivalent tools where a clean mapping exists (readArgs→read, shellArgs→bash, grepArgs→grep, writeArgs→write, lsArgs→ls, deleteArgs→bash rm, fetchArgs→bash curl). Redirects are gated against the session's enabled tool set before execution, so disabled tools are rejected instead of bypassing Pi's requested `tools` array. The result flows back as native protobuf so the model never retries. Obscure tools with no Pi equivalent (diagnostics, computerUse, recordScreen, backgroundShellSpawn) are rejected with an explanatory error.
_Avoid_: tool mapping, tool proxy, native tool rejection

**Tool Gating**:
Filtering every MCP passthrough, native redirect, and implicit Cursor interaction feature against the tool set Pi explicitly registered for the session. Unenabled tools return explicit rejection or `isError: true` responses so the model falls back to the tools Pi actually allowed.
_Avoid_: tool allowlist, permission layer, tool ACL

**MCP Tool**:
A tool definition registered via Cursor's `RequestContext` that the model uses as a fallback when no native tool redirection applies. These map 1:1 to Pi's tool definitions.
_Avoid_: external tool, custom tool

**Cloud Rule**:
A text field in Cursor's `RequestContext` protobuf message used to deliver system-level instructions that the model respects. Used instead of the `system` role, which Cursor ignores.
_Avoid_: system prompt, system message, rules

## Relationships

- The **Proxy** spawns one or more **Bridges** to handle concurrent requests, isolated by **Session ID**
- A **Bridge** translates **Native Tool Redirection** calls into OpenAI `tool_calls` for Pi, with results sent back as native protobuf
- A **Bridge** translates **MCP Tool** calls into OpenAI `tool_calls` for Pi, with results sent back as MCP protobuf
- The **Proxy** persists **Checkpoints** and **Blob Store** data to disk, keyed by **Session ID** + conversation
- The **Proxy** exposes the **Internal API** for heartbeats, token delivery, and model refresh
- Extension instances discover the **Proxy** via the **Port File**, or spawn a new one if none exists
- **Model Discovery** results are cached to disk as the **Model Cache** for fast subsequent startups

## Example dialogue

> **Dev:** "When a second Pi session starts, does it spawn its own Proxy?"
> **Domain expert:** "No — it reads the Port File, finds the existing Proxy, verifies the PID, and starts heartbeating via the Internal API. Each session's requests are isolated by Session ID."

> **Dev:** "What happens when Cursor's model tries to use its native `read` tool?"
> **Domain expert:** "The Proxy intercepts it via Native Tool Redirection — translates `readArgs` to Pi's `read` tool, executes it, and sends the result back as a native `ReadResult` protobuf. The model never knows it was redirected."

## Flagged ambiguities

- "bridge" in the opencode-cursor reference means both "the H2 connection" and "the Node child process that wraps it." Here, **Bridge** means the H2 connection only — the child process wrapper is eliminated because Pi runs on Node.js natively.
- "cost" — Pi tracks per-model costs in $/million tokens. Cursor models report **zero cost** because the user pays via their Cursor subscription, not per-token through this extension. Token counts (input/output/cache) are still tracked.
- "heartbeat" — Two different heartbeats exist: the extension→Proxy heartbeat via Internal API (proves sessions are alive), and the Proxy→Cursor heartbeat on the H2 stream (keeps the Bridge alive). Context makes the distinction clear.
