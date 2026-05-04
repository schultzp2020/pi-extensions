---
'@schultzp2020/pi-cursor': patch
---

Expose xhigh thinking level in pi's thinking-level selector

Pi-core's `getSupportedThinkingLevels` only includes `xhigh` when the model's
`thinkingLevelMap` explicitly defines it (unlike other levels which are opt-out).
Pi-cursor was not setting `thinkingLevelMap` at all, so `xhigh` never appeared
in the selector.

Now sets `thinkingLevelMap: { xhigh: 'xhigh' }` for models with effort maps,
which passes through to the proxy's `buildEffortMap` for Cursor effort resolution.
