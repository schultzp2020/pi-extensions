# Proxy handles transient retries, extension handles auth, Pi sees clean errors

Responsibility for error recovery is split three ways: the Proxy retries transient Cursor protocol errors internally (H2 stream death → resume from Checkpoint, rate limiting → exponential backoff), the extension handles token refresh (Proxy requests a new token via the Stdout Protocol, extension refreshes via Pi's OAuth credentials and pushes it on the Stdin Protocol), and Pi only sees errors that are genuinely unrecoverable (auth revoked, Cursor down, subscription expired).

## Considered Options

- **Bubble everything to Pi** — Simple, but Pi can't distinguish "retry same request" from "need token refresh" from "Cursor is down." User sees errors for transient blips.
- **Proxy handles everything** — Would require the proxy to own OAuth refresh, duplicating what Pi's credential store already does.
- **Split by ownership** — Proxy owns Cursor protocol recovery, extension owns auth, Pi owns user experience. Each layer handles what it knows about.
