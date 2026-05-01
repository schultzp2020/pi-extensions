---
'@schultzp2020/pi-cursor': patch
---

Fix native tool argument mapping for Pi MCP tools

Several native Cursor tool redirects sent incorrect arguments to Pi's MCP tools, causing validation failures:

- **`readArgs`/`writeArgs`**: Sent `filePath` instead of `path`, causing `Validation failed for tool "read": path: must have required properties path`
- **`lsArgs`**: Redirected to nonexistent `glob` tool instead of Pi's `ls` tool
- **`deleteArgs`/`fetchArgs`**: Sent extra `description` parameter not in `bash` tool schema
- **`fixMcpArgNames`**: Converted `path` → `filePath` (backwards) — now correctly converts `filePath` → `path` and covers all Pi tools with a `path` parameter (`read`, `write`, `edit`, `grep`, `find`, `ls`)
