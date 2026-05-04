# Session identity derived from Pi session ID, not message content

Session keys, conversation keys, and bridge keys are derived from Pi's stable session ID (`pi_session_id` injected via `before_provider_request`), not from hashing the first user message content.

The previous approach (`X-Session-Id` header with a random per-extension UUID + first user message hash) broke after session compaction: Pi replaces conversation history with a summary, changing the first user message, which produced different keys and orphaned all stored state (checkpoints, blob stores, active bridges).

## Considered Options

- **A: Content-based key derivation** (current) — Hash first user message for keys. Breaks on compaction, branch rewind, or any history rewrite. No code change needed.
- **B: Pi session ID via header** — Stable across compaction, but headers are out-of-band and harder to log/replay.
- **C: Pi session ID in request body** — Stable across compaction, travels with the payload, easy to log. Matches upstream approach. Requires `before_provider_request` hook.

## Decision

Option C. The extension injects `pi_session_id` into the request body via `before_provider_request`. The proxy extracts it and derives all session/conversation/bridge keys from it. Anonymous fallback (no session ID) degrades to content-based derivation for backward compatibility.

## Consequences

- Session compaction no longer breaks Cursor conversations.
- Fork, branch navigation, and `/tree` produce correct checkpoint invalidation via lineage fingerprint rather than key miss.
- The extension must register a `before_provider_request` hook.
- Lifecycle cleanup hooks (`session_before_switch`, `session_before_fork`, `session_before_tree`, `session_shutdown`) can now clean up by real session ID.
