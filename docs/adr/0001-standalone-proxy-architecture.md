# Standalone proxy instead of native streamSimple

We chose to run the Cursor protocol translation as a standalone Node.js proxy process managed by a Pi extension, rather than implementing Cursor's H2/protobuf protocol directly inside Pi's `streamSimple` callback.

The core reason is the bridge lifecycle mismatch. Cursor's gRPC protocol keeps an HTTP/2 stream alive during tool execution, but Pi's `streamSimple` contract is call-return-call — it ends the stream, executes tools, then calls again. Keeping a live H2 connection open between `streamSimple` calls requires module-level state that fights Pi's design. A standalone proxy owns the full H2 lifecycle internally, and Pi talks to it as a standard OpenAI-compatible endpoint using its existing `openai-completions` plumbing.

## Considered Options

- **A: Native `streamSimple`** — No extra process, but requires fragile cross-call bridge state, ambiguous AbortSignal handling, and orphaned heartbeat timers. Rejected because the bridge lifecycle complexity is fundamental, not incidental.

- **B: Standalone proxy + extension** — One extra Node process, but the proxy encapsulates all H2/protobuf/reject complexity. The extension handles lifecycle (spawn, health check, shutdown) and auth (OAuth token refresh). Pi sees a plain OpenAI endpoint.

## Consequences

- Process management (spawn, health, cleanup) must be cross-platform (Windows, macOS, Linux).
- Auth tokens must flow from the extension to the proxy without a closure boundary — solved per-request via headers or a local refresh endpoint.
- Startup adds 2-5 seconds for proxy spawn + model discovery.
