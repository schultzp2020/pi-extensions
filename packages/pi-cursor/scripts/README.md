# Developer Scripts

Standalone tools for debugging and inspecting the Cursor proxy. Not part of the published package.

## capture-model-parameters.ts

Calls Cursor's `AvailableModels` RPC with different flag combinations and dumps the raw responses as JSON. Useful for understanding what model metadata Cursor returns and how `useModelParameters` / `variantsWillBeShownInExplodedList` change the response shape.

```sh
# 1. Get your access token from the running proxy
curl http://localhost:<proxy-port>/internal/token

# 2. Run the script
CURSOR_TOKEN="your-token" npx tsx scripts/capture-model-parameters.ts
```

Outputs `capture-old.json`, `capture-new.json`, and `capture-exploded.json` in the working directory.

## debug-log-timeline.mjs

Transforms JSONL debug logs (from `debug-logger.ts`) into human-readable timelines grouped by request. Zero dependencies — runs with plain `node`.

```sh
# From a file
node scripts/debug-log-timeline.mjs path/to/cursor-debug.jsonl

# From stdin
cat cursor-debug.jsonl | node scripts/debug-log-timeline.mjs

# With filters
node scripts/debug-log-timeline.mjs log.jsonl --session abc123 --since 2025-01-01
```

Run with `--help` for all options.
