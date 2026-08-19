---
'@schultzp2020/pi-cursor': patch
---

Recover the live Cursor provider when its ready proxy child exits. Requests now perform one bounded health/reconnect attempt, switch to the respawned port, and persist credential-free exit and restart diagnostics.
