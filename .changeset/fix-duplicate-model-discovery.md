---
'@schultzp2020/pi-cursor': patch
---

Fix duplicate model discovery on proxy startup

When connecting to an existing proxy, `connectToProxy` called `/internal/refresh-models` which triggered a full `discoverCursorModels()` round-trip to Cursor's API — even though the proxy already had fresh models cached from startup. This caused the `Discovered N models via AvailableModels` log to appear twice.

Added a `GET /internal/models` endpoint that returns cached models without re-discovering, and switched `connectToProxy` to use it. The `/internal/refresh-models` POST endpoint is preserved for explicit refresh scenarios.
