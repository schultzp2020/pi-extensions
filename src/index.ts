import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@mariozechner/pi-coding-agent'

import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import { connectToProxy, getActivePort, readPortFile, stopHeartbeat } from './proxy-lifecycle.ts'
import type { CursorModel } from './proxy/models.ts'

const PROVIDER_ID = 'cursor'
const AGENT_DIR = join(homedir(), '.pi', 'agent')
const MODEL_CACHE_PATH = join(AGENT_DIR, 'cursor-model-cache.json')

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

function loadStoredToken(): string | null {
  try {
    const authPath = join(AGENT_DIR, 'auth.json')
    if (!existsSync(authPath)) {
      return null
    }
    const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'))
    if (typeof auth !== 'object' || auth === null) {
      return null
    }
    const { cursor } = auth as Record<string, unknown>
    if (typeof cursor !== 'object' || cursor === null) {
      return null
    }
    const { access } = cursor as { access?: string }
    return typeof access === 'string' ? access : null
  } catch {
    return null
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const sessionId = crypto.randomUUID()
  let currentPort: number | null = null
  let models: CursorModel[] = loadModelCache()

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
      const result = await connectToProxy(sessionId, accessToken)
      currentPort = result.port
      if (result.models.length > 0) {
        models = result.models // eslint-disable-line prefer-destructuring
        saveModelCache(models)
      }
    } catch {
      // proxy spawn failed — models will be empty until next attempt
    }
  }

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
        // Pushes fresh token to proxy. Does NOT re-register to avoid infinite loop.
        modifyModels(registeredModels, credentials) {
          void ensureProxy(credentials.access)
          return registeredModels
        },
      },
    })
  }

  // Try to connect to an existing proxy or spawn one with stored credentials
  const storedToken = loadStoredToken()
  const existingProxy = readPortFile()

  if (existingProxy) {
    try {
      const result = await connectToProxy(sessionId, storedToken)
      currentPort = result.port
      if (result.models.length > 0) {
        models = result.models // eslint-disable-line prefer-destructuring
        saveModelCache(models)
      }
    } catch {
      // no existing proxy available
    }
  }

  if (!currentPort && storedToken) {
    await ensureProxy(storedToken)
  }

  register()

  pi.on('session_shutdown', () => {
    stopHeartbeat()
  })
}
