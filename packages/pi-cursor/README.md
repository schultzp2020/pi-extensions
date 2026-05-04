# pi-cursor

A [Pi](https://github.com/badlogic/pi) extension that gives you access to all your [Cursor](https://cursor.com) subscription models (Composer, Claude, GPT, Gemini, etc.) inside Pi via a local OpenAI-compatible proxy.

## Features

- **Dynamic model discovery** — no hard-coded model list. Models are fetched from Cursor's API on startup and cached for fast subsequent launches.
- **Full tool support** — native Cursor tools (read, write, shell, grep) are redirected to Pi equivalents only when Pi enabled the mapped tool for the session. MCP tools pass through only when registered in the session tool set, and Cursor-only web/exa queries are rejected.
- **Thinking/reasoning** — `thinkingDelta` events map to `reasoning_content` in SSE, with XML tag filtering as a safety net.
- **Multi-session** — multiple Pi sessions share one proxy process via HTTP internal API and a port file at `~/.pi/agent/cursor-proxy.json`.
- **Conversation persistence** — checkpoints and blob stores are persisted to disk, preventing "blob not found" crashes on long sessions.

## Requirements

- [Pi](https://github.com/badlogic/pi) v0.71+
- [Node.js](https://nodejs.org) v22+
- An active [Cursor](https://cursor.com) subscription

## Installation

```bash
pi install npm:@schultzp2020/pi-cursor
```

## Usage

### 1. Authenticate

Inside Pi, run:

```
/login
```

Select **Cursor** from the provider dropdown, then your browser opens to Cursor's OAuth page. After you log in, Pi polls until authentication completes. Tokens are stored and refreshed automatically.

> **Windows note:** A console window may appear briefly when the browser opens. This is harmless — you can close it safely.

### 2. Select a model

```
/model
```

Pick any Cursor model from the list. By default (`modelMappings=normalized`), effort-level variants are collapsed — e.g. `gpt-5.4-low`, `gpt-5.4-medium`, `gpt-5.4-high` become a single `gpt-5.4` entry, with Pi's reasoning-effort setting controlling the variant sent to Cursor.

Set `modelMappings` to `raw` (or `PI_CURSOR_RAW_MODELS=1`) to see all raw Cursor model variants.

### 3. Chat

Use Pi normally. The extension transparently proxies requests to Cursor's API:

```
Read package.json and summarize the dependencies.
```

Tool calls, multi-turn conversations, and reasoning all work.

## Settings

Run `/cursor` in Pi to open the settings menu. Each setting shows its current value and an `[ENV]` tag when overridden by an environment variable (read-only in that case).

| Setting           | Values                         | Default      | Env Override                  |
| ----------------- | ------------------------------ | ------------ | ----------------------------- |
| Native Tools Mode | `reject`, `redirect`, `native` | `reject`     | `PI_CURSOR_NATIVE_TOOLS_MODE` |
| Max Mode          | `on`, `off`                    | `off`        | `PI_CURSOR_MAX_MODE`          |
| Model Mappings    | `normalized`, `raw`            | `normalized` | `PI_CURSOR_RAW_MODELS`        |
| Max Retries       | `0`, `1`, `2`, `3`, `5`        | `2`          | `PI_CURSOR_MAX_RETRIES`       |

Settings persist to `~/.pi/agent/cursor-config.json`. Changing **Model Mappings** triggers provider re-registration to update the model picker. **Max Mode** is hidden when Model Mappings is set to `raw`.

## Native Tools Mode

Controls how Cursor's built-in tool calls (read, write, shell, grep, ls, delete, fetch) are handled:

| Mode               | Behavior                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- |
| `reject` (default) | All native Cursor tool calls are rejected. Only Pi's MCP tools succeed.                |
| `redirect`         | Overlapping native tools are transparently redirected through Pi equivalents.          |
| `native`           | Overlapping tools execute locally within the proxy, sandboxed to the nearest git root. |

Configure via the `/cursor` command or environment variable:

```bash
export PI_CURSOR_NATIVE_TOOLS_MODE=native  # or reject, redirect
```

Or set it in `~/.pi/agent/cursor-config.json`:

```json
{
  "nativeToolsMode": "native"
}
```

In `native` mode, filesystem operations are sandboxed to the **Allowed Root** — the nearest git root of the session's working directory. Paths outside this boundary are rejected.

## Debug Logging

Enable structured debug logging to diagnose proxy behavior:

```bash
export PI_CURSOR_PROVIDER_DEBUG=1
```

This writes JSONL entries to `~/.pi/agent/cursor-debug.jsonl`. Override the path:

```bash
export PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE=/path/to/debug.jsonl
```

View a human-readable timeline:

```bash
node packages/pi-cursor/scripts/debug-log-timeline.mjs ~/.pi/agent/cursor-debug.jsonl

# Filter by session or time range
node packages/pi-cursor/scripts/debug-log-timeline.mjs --session <id> --since 2026-05-04T00:00:00Z
```

When disabled (default), all debug functions are zero-cost no-ops.

## Architecture

```
Pi ──(OpenAI API)──▶ Local Proxy ──(gRPC/H2)──▶ api2.cursor.sh
                       :PORT                      Cursor API
```

The extension spawns a standalone proxy process that translates between OpenAI's chat completions format and Cursor's protobuf Connect protocol over HTTP/2. The proxy is built with [Rolldown](https://rolldown.rs) for tree-shaking and ships as plain JS — no TypeScript flags needed at runtime.

### Key design decisions

See [`docs/adr/`](docs/adr/) for Architecture Decision Records.

## Development

```bash
npm run build         # Build with Rolldown (~22ms)
npm test              # Run unit tests
npm run test:watch    # Watch mode
npm run lint          # Lint with oxlint (type-aware, strict)
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format with oxfmt
npm run format:check  # Check formatting
npm run generate      # Regenerate proto types from proto/aiserver.proto
```

### Proto files

The `proto/aiserver.proto` file and `src/proto/agent_pb.ts` are vendored from the [Hardcode84/opencode-cursor](https://github.com/Hardcode84/opencode-cursor) fork (`cursor-persists` branch). To regenerate `aiserver_pb.ts`:

```bash
npm run generate
```

The `agent_pb.ts` is vendored directly (the `.proto` source is not publicly available) and should not be regenerated.

## How it works

1. **Login** — PKCE OAuth flow opens `cursor.com/loginDeepControl` in the browser, polls `api2.cursor.sh/auth/poll` until the user completes login.
2. **Proxy startup** — Extension spawns a child process running the built proxy. The proxy opens an HTTP server on a random port and writes `{"type":"ready","port":N,"models":[...]}` to stdout.
3. **Model discovery** — Proxy calls `AvailableModels` (or `GetUsableModels` as fallback) via gRPC to fetch the user's available models. Results are cached to disk for fast subsequent starts.
4. **Provider registration** — Extension registers a `cursor` provider with Pi using `api: 'openai-completions'`, pointing `baseUrl` at the local proxy.
5. **Chat completion** — Pi sends standard OpenAI requests to the proxy. The proxy builds an `AgentRunRequest` protobuf, opens an H2 stream to `api2.cursor.sh`, and translates the response back into SSE chunks.
6. **Tool calls** — Cursor's native tools (read, write, shell) are intercepted and emitted as OpenAI `tool_calls` only if the mapped Pi tool is enabled for the session. MCP tool calls are gated against the same registered tool set, and Cursor-only web/exa queries are rejected so the model falls back to available tools. Results flow back as protobuf frames.
7. **Multi-session** — The proxy writes a port file at `~/.pi/agent/cursor-proxy.json`. Other Pi sessions discover and reuse the same proxy. Each session sends heartbeats every 10s; the proxy exits 30s after the last heartbeat stops.

## License

[MIT](LICENSE)
