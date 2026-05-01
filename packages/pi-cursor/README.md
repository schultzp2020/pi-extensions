# pi-cursor

A [Pi](https://github.com/badlogic/pi) extension that gives you access to all your [Cursor](https://cursor.com) subscription models (Composer, Claude, GPT, Gemini, etc.) inside Pi via a local OpenAI-compatible proxy.

## Features

- **Dynamic model discovery** — no hard-coded model list. Models are fetched from Cursor's API on startup and cached for fast subsequent launches.
- **Full tool support** — native Cursor tools (read, write, shell, grep) are redirected to Pi equivalents. MCP tools pass through.
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

Pick any Cursor model from the list. Models that support max mode appear as both `model-name` and `model-name-max` variants.

### 3. Chat

Use Pi normally. The extension transparently proxies requests to Cursor's API:

```
Read package.json and summarize the dependencies.
```

Tool calls, multi-turn conversations, and reasoning all work.

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
6. **Tool calls** — Cursor's native tools (read, write, shell) are intercepted and emitted as OpenAI `tool_calls`, which Pi executes with its own tools. Results flow back as protobuf frames.
7. **Multi-session** — The proxy writes a port file at `~/.pi/agent/cursor-proxy.json`. Other Pi sessions discover and reuse the same proxy. Each session sends heartbeats every 10s; the proxy exits 30s after the last heartbeat stops.

## License

[MIT](LICENSE)
