import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_PATH = join(homedir(), '.pi', 'agent', 'cursor-proxy.log')

function log(msg: string): void {
  const line = `${new Date().toISOString()} [ext] ${msg}\n`
  try {
    mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true })
    appendFileSync(LOG_PATH, line)
  } catch {
    // best effort
  }
}

/**
 * Pi extension entry point for Cursor subscription models.
 *
 * Registers a 'cursor' provider that routes through a local
 * OpenAI-compatible proxy process. Supports OAuth login via
 * `/login cursor`, dynamic model discovery, token refresh,
 * and proxy lifecycle management.
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from '@mariozechner/pi-coding-agent'

import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import { connectToProxy, getActivePort, readPortFile, stopHeartbeat } from './proxy-lifecycle.ts'
import type { CursorModel } from './proxy/models.ts'

// ── Constants ──

const PROVIDER_ID = 'cursor'
const MODEL_CACHE_DIR = join(homedir(), '.pi', 'agent')
const MODEL_CACHE_PATH = join(MODEL_CACHE_DIR, 'cursor-model-cache.json')
const TOKEN_PUSH_TIMEOUT_MS = 2_000

// ── Model cache ──

function loadModelCache(): CursorModel[] {
  try {
    if (!existsSync(MODEL_CACHE_PATH)) {
      return []
    }
    return JSON.parse(readFileSync(MODEL_CACHE_PATH, 'utf8')) as CursorModel[]
  } catch {
    return []
  }
}

function saveModelCache(models: CursorModel[]): void {
  try {
    mkdirSync(MODEL_CACHE_DIR, { recursive: true })
    writeFileSync(MODEL_CACHE_PATH, JSON.stringify(models))
  } catch {
    // Non-fatal — cache miss on next startup at worst
  }
}

// ── Model conversion ──

function toProviderModels(models: CursorModel[]): ProviderModelConfig[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: (m.supportsImages ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }))
}

// ── Push token to proxy ──

async function pushTokenToProxy(port: number, accessToken: string): Promise<void> {
  try {
    await fetch(`http://localhost:${String(port)}/internal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: accessToken }),
      signal: AbortSignal.timeout(TOKEN_PUSH_TIMEOUT_MS),
    })
  } catch {
    // Non-fatal — will retry on next request
  }
}

// ── Extension factory ──

export default async function (pi: ExtensionAPI): Promise<void> {
  log('Extension loading...')
  const sessionId = crypto.randomUUID()
  let currentPort: number | null = null
  let models: CursorModel[] = loadModelCache()
  log(`Loaded ${String(models.length)} cached models`)

  // ── OAuth login ──

  async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { verifier, uuid, loginUrl } = await generateCursorAuthParams()
    callbacks.onAuth({ url: loginUrl })
    const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier)
    return {
      refresh: refreshToken,
      access: accessToken,
      expires: getTokenExpiry(accessToken),
    }
  }

  // ── Token refresh ──

  async function onRefreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const result = await refreshCursorToken(credentials.refresh)
    // Push refreshed token to proxy if running
    const port = getActivePort()
    if (port) {
      await pushTokenToProxy(port, result.access)
    }
    return result
  }

  // ── Build provider config ──

  function buildProviderConfig(): ProviderConfig {
    return {
      name: 'Cursor',
      baseUrl: currentPort ? `http://localhost:${String(currentPort)}/v1` : 'http://localhost:0/v1',
      apiKey: 'cursor-proxy',
      api: 'openai-completions',
      models: currentPort ? toProviderModels(models) : [],
      headers: { 'X-Session-Id': sessionId },
      oauth: {
        name: 'Cursor',
        login: loginCursor,
        refreshToken: onRefreshToken,
        getApiKey: (cred) => cred.access,
        modifyModels(registeredModels, credentials) {
          log('modifyModels called, launching proxy...')
          void connectAndRefresh(credentials.access)
          return registeredModels
        },
      },
    }
  }

  // ── Helpers ──

  function updateModels(newModels: CursorModel[]): void {
    models = newModels
    saveModelCache(models)
  }

  // ── Connect to proxy and refresh models ──

  async function connectAndRefresh(accessToken: string): Promise<void> {
    try {
      log('connectAndRefresh: connecting to proxy...')
      const result = await connectToProxy(sessionId, accessToken)
      currentPort = result.port
      log(`Proxy on port ${String(result.port)}, got ${String(result.models.length)} models`)
      if (result.models.length > 0) {
        updateModels(result.models)
        pi.registerProvider(PROVIDER_ID, buildProviderConfig())
        log(`Provider re-registered with ${String(result.models.length)} models`)
      }
    } catch (error) {
      log(`Failed to connect to proxy: ${String(error)}`)
    }
  }

  // ── Startup: try connecting to existing proxy ──

  const existing = readPortFile()
  if (existing) {
    log('Found existing proxy, attempting reconnect...')
    try {
      const result = await connectToProxy(sessionId, null)
      currentPort = result.port
      if (result.models.length > 0) {
        updateModels(result.models)
      }
      log(`Reconnected to existing proxy on port ${String(result.port)}`)
    } catch {
      log('No existing proxy available, waiting for /login')
    }
  } else {
    log('No existing proxy found, waiting for /login')
  }

  // ── Register provider ──

  pi.registerProvider(PROVIDER_ID, buildProviderConfig())
  log(`Provider registered (${String(models.length)} models, port=${String(currentPort)})`)
  log('Extension loaded. Run /login cursor to authenticate.')

  // ── Lifecycle: stop heartbeat on shutdown ──

  pi.on('session_shutdown', () => {
    stopHeartbeat()
  })
}
