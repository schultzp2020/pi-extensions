---
'@schultzp2020/pi-cursor': patch
---

Update workspace dependencies after changelog review, and fix Pi 0.84 OAuth abort handling.

**Breaking/deprecation fixes applied**

- `@earendil-works/pi-ai` / `pi-coding-agent` 0.76 → 0.84.1: honor `OAuthLoginCallbacks.signal` during login polling and `refreshToken(credentials, signal)` without discarding a successful token exchange; pass the caller signal into proxy token pushes.
- TypeScript 6 → 7: set `"types": ["node"]` (TS 7 no longer auto-includes `@types/*`).
- `oxlint-tsgolint` 0.23 → 7.0.2001 (versioning now tracks TS 7): remove unnecessary type assertions flagged by the stricter rule set.
- Rolldown 1.0 → 1.2: suppress `INVALID_ANNOTATION` only for generated `src/proto/**` via `onLog` (keep the check for handwritten code).
- `@changesets/cli` 2 → 3 / `changelog-github` 0.7 → 1: bump config schema to `@changesets/config@4`; no `prettier`→`format` migration needed for this repo.

**Other bumps**

- `@bufbuild/protobuf` / `protoc-gen-es` → 2.14.0, `@bufbuild/buf` → 1.72.0
- `oxfmt`, `oxlint`, `lint-staged`, `rolldown`, `vitest`, `@types/node` → current latest

Also add `.gitattributes` (`eol=lf`) so oxfmt's LF policy stays stable across Windows checkouts.

Centralize `unknown`/JSON trust-boundary helpers in `src/unknown.ts` so TypeScript and type-aware lint upgrades do not require cast cleanups scattered across call sites.
