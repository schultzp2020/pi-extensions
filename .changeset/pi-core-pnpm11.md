---
'@schultzp2020/pi-cursor': minor
---

Migrate to the `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` packages (renamed from `@mariozechner/*`). Adopt Pi core's `thinkingLevelMap` contract for reasoning-level controls, replacing the previous `compat.reasoningEffortMap` approach. Unsupported thinking levels are now explicitly marked as `null` so Pi's selector hides them instead of silently falling through.
