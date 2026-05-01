# Shared proxy with HTTP internal API instead of per-session stdin

Multiple Pi sessions (including intercom-coordinated agent teams) share a single Proxy process. All ongoing communication between extensions and the Proxy uses HTTP endpoints (`/internal/*`) rather than stdin/stdout pipes.

The original design used a JSON-lines stdin protocol for heartbeats and token delivery, which only works when one parent process owns the pipe. Multi-session support requires a protocol that any extension instance can use without owning the process's stdio. HTTP endpoints on the Proxy are the simplest uniform channel — every session heartbeats, pushes tokens, and requests model refreshes the same way, regardless of whether it spawned the Proxy or discovered it via the Port File.

Stdout is still used for initial port discovery by the spawning session. Stdin-close remains a passive safety net (no heartbeats → timeout → exit).

## Considered Options

- **Stdin for spawner + HTTP for others** — Two code paths for the same operations. More complex proxy, harder to test, and the spawning session behaves differently from every other session.
- **All HTTP** — One protocol for all sessions. Proxy tracks active sessions by heartbeat. Port File enables discovery. Uniform behavior regardless of how a session connects.
