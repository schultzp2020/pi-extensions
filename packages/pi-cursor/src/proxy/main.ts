import { unlinkSync } from 'node:fs'
/**
 * Proxy HTTP server — main entry point.
 *
 * Reads config from stdin, discovers models, starts an HTTP server on
 * an ephemeral port, and writes a ready signal to stdout.  Routes:
 *
 *   GET  /v1/models            → OpenAI-format model list
 *   POST /v1/chat/completions  → chat completion (SSE or non-streaming)
 *   /internal/*                → delegate to internal-api
 *   *                          → 404
 */
import { createServer, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { resolveEffective } from './config.ts'
import { errorResponse, jsonResponse } from './http-helpers.ts'
import {
  configureInternalApi,
  getAccessToken,
  getCachedModels,
  handleInternalRequest,
  startHeartbeatMonitor,
} from './internal-api.ts'
import { processModels, type NormalizedModelSet } from './model-normalization.ts'
import { discoverCursorModels, type CursorModel } from './models.ts'
import { handleChatCompletion, type ProxyContext } from './request-lifecycle.ts'
import { closeAll, evict, type ConversationConfig } from './session-state.ts'

// ── Types ──

interface ProxyConfig {
  accessToken: string
  conversationDir?: string
}

// ── Model management ──

/** Cached normalized model set, rebuilt on model discovery */
let cachedNormalizedSet: NormalizedModelSet | null = null

/** Get or build the normalized model set from the current raw models */
function getNormalizedModelSet(): NormalizedModelSet {
  cachedNormalizedSet ??= processModels(getCachedModels())
  return cachedNormalizedSet
}

/** Call when raw models change (discovery, refresh) to invalidate cached normalization */
function invalidateNormalizedModels(): void {
  cachedNormalizedSet = null
}

function handleModelsRequest(res: ServerResponse, _models: CursorModel[]): void {
  const effectiveModels = getNormalizedModelSet().models

  const data = effectiveModels.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cursor',
  }))
  jsonResponse(res, 200, { object: 'list', data })
}

// ── Startup ──

async function main(): Promise<void> {
  // 1. Read config from stdin
  const rl = createInterface({ input: process.stdin })
  const configLine = await new Promise<string>((resolve) => {
    rl.once('line', resolve)
  })
  rl.close()

  let config: ProxyConfig
  try {
    config = JSON.parse(configLine) as ProxyConfig
  } catch {
    console.error('[proxy] Invalid JSON config on stdin')
    process.exit(1)
  }

  if (!config.accessToken) {
    console.error('[proxy] accessToken is required')
    process.exit(1)
  }

  const convConfig: ConversationConfig = {
    conversationDiskDir: config.conversationDir ?? join(tmpdir(), 'pi-cursor-conversations'),
  }

  const portFilePath = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')

  function shutdown(): void {
    console.error('[proxy] Shutdown requested')
    closeAll()
    try {
      unlinkSync(portFilePath)
    } catch {
      /* may not exist */
    }
    process.exit(0)
  }

  // 2. Discover models
  let models: CursorModel[] = []
  try {
    models = await discoverCursorModels(config.accessToken)
    console.error(`[proxy] Discovered ${String(models.length)} models`)
  } catch (error) {
    console.error('[proxy] Model discovery failed:', error)
  }

  // 3. Configure internal API (once, after model discovery)
  configureInternalApi({
    initialToken: config.accessToken,
    initialModels: models,
    onModelsRefreshed: () => invalidateNormalizedModels(),
    onShutdown: shutdown,
  })

  // 4. Build ProxyContext for request handling
  const proxyCtx: ProxyContext = {
    getAccessToken,
    getNormalizedSet: getNormalizedModelSet,
    convConfig,
    get config() {
      const cfg = resolveEffective()
      return {
        nativeToolsMode: cfg.nativeToolsMode,
        maxMode: cfg.maxMode,
        fast: cfg.fast,
        thinking: cfg.thinking,
        maxRetries: cfg.maxRetries,
      }
    },
  }

  // 5. Start HTTP server
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (url.pathname.startsWith('/internal/')) {
      void handleInternalRequest(req, res, url.pathname)
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      handleModelsRequest(res, getCachedModels())
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      void handleChatCompletion(req, res, proxyCtx).catch((error) => {
        console.error('[proxy] Chat completion error:', error)
        if (!res.headersSent) {
          errorResponse(res, 500, 'Internal server error')
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  })

  // 6. Start periodic session eviction
  const evictionTimer = setInterval(() => {
    evict()
  }, 60_000)
  if (typeof evictionTimer === 'object' && 'unref' in evictionTimer) {
    evictionTimer.unref()
  }

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0

    // 7. Write ready signal to stdout (extension reads this)
    const readySignal = JSON.stringify({
      type: 'ready',
      port,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImages: m.supportsImages,
      })),
    })
    console.log(readySignal)

    // 8. Start heartbeat monitor
    startHeartbeatMonitor()

    console.error(`[proxy] Listening on port ${String(port)}`)
  })
}

main().catch((error) => {
  console.error('[proxy] Fatal:', error)
  process.exit(1)
})
