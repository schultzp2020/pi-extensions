# Three-mode native tools policy: reject, redirect, native

Cursor's built-in tool calls are handled according to a configurable policy with three modes, defaulting to `reject`.

The previous behavior was a hardcoded hybrid: overlapping tools were always redirected through Pi equivalents, and remaining tools were always rejected. This made the behavior implicit, untestable, and impossible to change without code edits.

## Modes

- **`reject`** (default) — All native Cursor tool calls are rejected. Only explicit MCP/Pi tools succeed. Strictest mode, matches Pi's simple-by-default philosophy.
- **`redirect`** — Overlapping native tools (read, write, delete, shell, shellStream, ls, grep, fetch) are transparently executed through Pi's equivalent tools. Remaining Cursor tools are rejected unless explicitly supported.
- **`native`** — Overlapping tools are executed as true proxy-local operations within the session's Allowed Root (nearest git root of `ctx.cwd`). The "prefer mcp*pi*\* tools" prompt guidance is removed. Remaining Cursor tools are rejected until explicitly implemented.

## Considered Options

- **A: Keep hardcoded redirect** — No user control, no clear contract, overlapping tools always go through Pi regardless of intent.
- **B: Two modes (redirect/reject)** — Simpler, but no path to true native execution for users who want Cursor's original tool behavior.
- **C: Three modes** — Full spectrum from strictest (reject) to most permissive (native). Each mode has clear, distinct semantics.

## Decision

Option C. Breaking change: default shifts from implicit redirect to explicit `reject`. Acceptable pre-1.0.

## Consequences

- `request-context.ts` must emit mode-dependent prompt guidance instead of always preferring `mcp_pi_*`.
- `native` mode requires proxy-local tool implementations with filesystem sandboxing.
- The Allowed Root is captured per session from the nearest git root containing `ctx.cwd`.
- Unsupported remaining tools clearly reject in all modes for now, with room to implement them incrementally.
- Setting is persisted in `cursor-config.json` and overridable via environment variable.
