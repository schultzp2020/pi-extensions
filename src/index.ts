import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@mariozechner/pi-coding-agent'

import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import { connectToProxy, getActivePort, readPortFile, stopHeartbeat } from './proxy-lifecycle.ts'
import type { CursorModel } from './proxy/models.ts'

// ── Constants ──

const PROVIDER_ID = 'cursor'
const AGENT_DIR = join(homedir(), '.pi', 'agent')
const MODEL_CACHE_PATH = join(AGENT_DIR, 'cursor-model-cache.json')
const LOG_PATH = join(AGENT_DIR, 'cursor-proxy.log')

// ── Logging ──

function log(msg: string): void {
  try {
    mkdirSync(AGENT_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [ext] ${msg}\n`)
  } catch {
    // best effort
  }
}

// ── Model cache (disk) ──

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
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(MODEL_CACHE_PATH, JSON.stringify(models))
  } catch {
    // non-fatal
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

// ── Stored credentials ──

function loadStoredToken(): string | null {
  try {
    const authPath = join(AGENT_DIR, 'auth.json')
    if (!existsSync(authPath)) {
      return null
    }
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, { access?: string }>
    return auth.cursor?.access ?? null
  } catch {
    return null
  }
}

// ── Extension entry point ──

export default async function (pi: ExtensionAPI): Promise<void> {
  log('Extension loading...')
  const sessionId = crypto.randomUUID()
  let currentPort: number | null = null
  let models: CursorModel[] = loadModelCache()
  log(`Loaded ${String(models.length)} cached models`)

  // ── OAuth ──

  async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { verifier, uuid, loginUrl } = await generateCursorAuthParams()
    callbacks.onAuth({ url: loginUrl })
    const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier)
    return { refresh: refreshToken, access: accessToken, expires: getTokenExpiry(accessToken) }
  }

  async function onRefreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const result = await refreshCursorToken(credentials.refresh)
    const port = getActivePort()
    if (port) {
      await pushToken(port, result.access)
    }
    return result
  }

  // ── Proxy communication ──

  async function pushToken(port: number, accessToken: string): Promise<void> {
    try {
      await fetch(`http://localhost:${String(port)}/internal/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access: accessToken }),
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      // non-fatal
    }
  }

  async function ensureProxy(accessToken: string): Promise<void> {
    if (currentPort) {
      await pushToken(currentPort, accessToken)
      return
    }
    try {
      log('Spawning proxy...')
      const result = await connectToProxy(sessionId, accessToken)
      currentPort = result.port
      if (result.models.length > 0) {
        models = result.models
        saveModelCache(models)
      }
      log(`Proxy ready on port ${String(currentPort)}, ${String(models.length)} models`)
    } catch (error) {
      log(`Failed to connect to proxy: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── Register provider (once) ──

  function register(): void {
    pi.registerProvider(PROVIDER_ID, {
      name: 'Cursor',
      baseUrl: currentPort ? `http://localhost:${String(currentPort)}/v1` : 'http://localhost:0/v1',
      apiKey: 'cursor-proxy',
      api: 'openai-completions',
      models: toProviderModels(models),
      headers: { 'X-Session-Id': sessionId },
      oauth: {
        name: 'Cursor',
        login: loginCursor,
        refreshToken: onRefreshToken,
        getApiKey: (cred) => cred.access,
        modifyModels(registeredModels, credentials) {
          // Pi calls this after login/refresh with fresh credentials.
          // We use it only to ensure the proxy has the latest token.
          // We do NOT re-register the provider here to avoid an infinite loop.
          void ensureProxy(credentials.access)
          return registeredModels
        },
      },
    })
  }

  // ── Startup ──

  const storedToken = loadStoredToken()
  const existingProxy = readPortFile()

  if (existingProxy) {
    log('Found existing proxy, reconnecting...')
    try {
      const result = await connectToProxy(sessionId, storedToken)
      currentPort = result.port
      if (result.models.length > 0) {
        models = result.models
        saveModelCache(models)
      }
      log(`Reconnected on port ${String(currentPort)}`)
    } catch {
      log('Existing proxy unavailable')
    }
  }

  if (!currentPort && storedToken) {
    log('Spawning proxy with stored credentials...')
    await ensureProxy(storedToken)
  }

  register()
  log(`Ready: ${String(models.length)} models, port=${String(currentPort)}`)

  // ── Lifecycle ──

  pi.on('session_shutdown', () => {
    stopHeartbeat()
  })
}
