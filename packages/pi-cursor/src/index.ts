import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import { FALLBACK_MODELS } from './fallback-models.ts'
import { connectToProxy, getActivePort, pushToken, readPortFile, stopHeartbeat } from './proxy-lifecycle.ts'
import {
  getEnvOverrides,
  resolveEffective,
  saveConfig,
  type CursorConfig,
  type NativeToolsMode,
} from './proxy/config.ts'
import { initDebugLogger, logLifecycle } from './proxy/debug-logger.ts'
import { processModels, type NormalizedModelSet } from './proxy/model-normalization.ts'
import type { CursorModel } from './proxy/models.ts'

const PROVIDER_ID = 'cursor'
const AGENT_DIR = join(homedir(), '.pi', 'agent')
const MODEL_CACHE_PATH = join(AGENT_DIR, 'cursor-model-cache.json')

function loadModelCache(): CursorModel[] {
  try {
    if (!existsSync(MODEL_CACHE_PATH)) {
      return FALLBACK_MODELS
    }
    const cached = JSON.parse(readFileSync(MODEL_CACHE_PATH, 'utf8')) as CursorModel[]
    return cached.length > 0 ? cached : FALLBACK_MODELS
  } catch {
    return FALLBACK_MODELS
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

/** Format a token count as a human-readable string (e.g. 200000 → "200K", 1000000 → "1M") */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${String(tokens / 1_000_000)}M`
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${String(tokens / 1_000)}K`
  }
  return String(tokens)
}

function toProviderModels(models: CursorModel[], modelSet?: NormalizedModelSet): ProviderModelConfig[] {
  return models.flatMap((m) => {
    const base: ProviderModelConfig = {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: (m.supportsImages ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }

    // Expose per-model thinking controls for models with effort maps.
    // Pi core reads thinkingLevelMap to populate the reasoning-effort selector.
    if (modelSet) {
      const effortMap = modelSet.effortMaps.get(m.id)
      if (effortMap) {
        base.compat = {
          supportsReasoningEffort: true,
        } as ProviderModelConfig['compat']

        const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
        const thinkingLevelMap: Partial<Record<(typeof thinkingLevels)[number], string | null>> = {}
        for (const key of thinkingLevels) {
          thinkingLevelMap[key] = effortMap[key] ?? null
        }
        base.thinkingLevelMap = thinkingLevelMap
      }
    }

    const results: ProviderModelConfig[] = [base]

    // Register additional models for larger context tiers.
    // Each model's tiers come from the API (contextTokenLimit / contextTokenLimitForMaxMode).
    // The base model uses the default tier; larger tiers get a [size] suffix in the name
    // and ~{tokens} in the ID so the proxy can detect and send the appropriate parameter.
    if (m.contextWindowMaxMode && m.contextWindowMaxMode > m.contextWindow) {
      results.push({
        ...base,
        id: `${m.id}~${String(m.contextWindowMaxMode)}`,
        name: `${m.name} [${formatTokenCount(m.contextWindowMaxMode)}]`,
        contextWindow: m.contextWindowMaxMode,
      })
    }

    return results
  })
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
  // Initialize debug logger (reads env vars)
  initDebugLogger()

  // Temporary ID for initial proxy connection; replaced by real Pi session ID on session_start
  let sessionId: string = crypto.randomUUID()
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

  let registeredPort: number | null = null

  function updateModels(newModels: CursorModel[]): void {
    models = newModels
    saveModelCache(models)
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
        updateModels(result.models)
      }
    } catch {
      // proxy spawn failed — models will be empty until next attempt
    }
    // Re-register if the proxy port changed (e.g. proxy restarted)
    if (currentPort && currentPort !== registeredPort) {
      register()
    }
  }

  function register(): void {
    registeredPort = currentPort
    let providerModels: ProviderModelConfig[]
    if (models.length > 0) {
      const modelSet = processModels(models)
      providerModels = toProviderModels(modelSet.models, modelSet)
    } else {
      providerModels = toProviderModels(models)
    }

    pi.registerProvider(PROVIDER_ID, {
      name: 'Cursor',
      baseUrl: currentPort ? `http://localhost:${String(currentPort)}/v1` : 'http://localhost:0/v1',
      apiKey: 'cursor-proxy',
      api: 'openai-completions',
      models: providerModels,
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
        updateModels(result.models)
      }
    } catch {
      // no existing proxy available
    }
  }

  if (!currentPort && storedToken) {
    await ensureProxy(storedToken)
  }

  register()

  // ── /cursor settings command ──

  pi.registerCommand('cursor', {
    description: 'Cursor provider settings',
    async handler(_args, ctx) {
      const cfg = resolveEffective()
      const envOverrides = getEnvOverrides()

      // Build menu rows
      type SettingKey = 'nativeToolsMode' | 'maxMode' | 'fast' | 'thinking' | 'maxRetries'
      interface SettingRow {
        key: SettingKey
        label: string
        display: string
        envLocked: boolean
      }

      function formatValue(key: SettingKey, cfg: CursorConfig): string {
        if (key === 'maxMode' || key === 'fast' || key === 'thinking') {
          return cfg[key] ? 'on' : 'off'
        }
        return String(cfg[key])
      }

      const rows: SettingRow[] = []

      rows.push({
        key: 'maxMode',
        label: 'Max Mode',
        display: formatValue('maxMode', cfg),
        envLocked: 'maxMode' in envOverrides,
      })

      rows.push({
        key: 'fast',
        label: 'Fast',
        display: formatValue('fast', cfg),
        envLocked: 'fast' in envOverrides,
      })

      rows.push({
        key: 'thinking',
        label: 'Thinking',
        display: formatValue('thinking', cfg),
        envLocked: 'thinking' in envOverrides,
      })

      rows.push({
        key: 'nativeToolsMode',
        label: 'Native Tools Mode',
        display: formatValue('nativeToolsMode', cfg),
        envLocked: 'nativeToolsMode' in envOverrides,
      })

      rows.push({
        key: 'maxRetries',
        label: 'Max Retries',
        display: formatValue('maxRetries', cfg),
        envLocked: 'maxRetries' in envOverrides,
      })

      // Build display options
      const options = rows.map((r) => {
        const envTag = r.envLocked ? ' [ENV]' : ''
        return `${r.label}: ${r.display}${envTag}`
      })

      const selected = await ctx.ui.select('Cursor Settings', options)
      if (!selected) {
        return
      }

      const selectedIndex = options.indexOf(selected)
      if (selectedIndex < 0) {
        return
      }
      const row = rows[selectedIndex]

      if (row.envLocked) {
        const envVar = envOverrides[row.key]
        ctx.ui.notify(`${row.label} is overridden by ${envVar ?? 'environment variable'}`, 'warning')
        return
      }

      // Show value sub-menu
      const valueOptions: Record<SettingKey, string[]> = {
        nativeToolsMode: ['reject', 'redirect', 'native'],
        maxMode: ['on', 'off'],
        fast: ['on', 'off'],
        thinking: ['on', 'off'],
        maxRetries: ['0', '1', '2', '3', '5'],
      }

      const values = valueOptions[row.key]
      const selectedValue = await ctx.ui.select(row.label, values)
      if (!selectedValue) {
        return
      }

      // Convert selected value to config value
      const update: Partial<CursorConfig> = {}
      switch (row.key) {
        case 'nativeToolsMode': {
          update.nativeToolsMode = selectedValue as NativeToolsMode
          break
        }
        case 'maxMode': {
          update.maxMode = selectedValue === 'on'
          break
        }
        case 'fast': {
          update.fast = selectedValue === 'on'
          break
        }
        case 'thinking': {
          update.thinking = selectedValue === 'on'
          break
        }
        case 'maxRetries': {
          update.maxRetries = Number.parseInt(selectedValue, 10)
          break
        }
      }

      saveConfig(update)
      ctx.ui.notify(`${row.label} set to ${selectedValue}`, 'info')
    },
  })

  // Capture real Pi session ID once the session is available
  pi.on('session_start', (_event, ctx) => {
    const realId = ctx.sessionManager.getSessionId()
    if (realId && realId !== sessionId) {
      sessionId = realId
      // Re-register provider so the X-Session-Id header uses the real ID
      register()
    }
    logLifecycle(sessionId, '', { event: 'session_start' })
  })

  // Inject pi_session_id and pi_cwd only when the request is routed through the
  // pi-cursor proxy (provider === 'cursor').  Other providers (anthropic-vertex,
  // openai, etc.) send requests directly to their API and reject unknown fields.
  pi.on('before_provider_request', (event, ctx) => {
    const currentModel = ctx.model
    if (currentModel?.provider !== 'cursor') {
      return event.payload
    }
    const { payload } = event
    if (typeof payload === 'object' && payload !== null) {
      ;(payload as Record<string, unknown>).pi_session_id = sessionId
      ;(payload as Record<string, unknown>).pi_cwd = ctx.cwd
    }
    return payload
  })

  // ── Lifecycle cleanup hooks ──
  // Each calls the proxy's cleanup endpoint to close active sessions and evict state

  async function cleanupCurrentSession(): Promise<void> {
    if (!currentPort) {
      return
    }
    try {
      await fetch(`http://localhost:${String(currentPort)}/internal/cleanup-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      // Best-effort cleanup — proxy may be unreachable or slow
    }
  }

  async function onBeforeSessionChange(event: string): Promise<void> {
    logLifecycle(sessionId, '', { event })
    await cleanupCurrentSession()
  }

  pi.on('session_before_switch', () => onBeforeSessionChange('session_before_switch'))
  pi.on('session_before_fork', () => onBeforeSessionChange('session_before_fork'))
  pi.on('session_before_tree', () => onBeforeSessionChange('session_before_tree'))

  pi.on('session_shutdown', async () => {
    logLifecycle(sessionId, '', { event: 'session_shutdown' })
    await cleanupCurrentSession()
    stopHeartbeat()
  })
}
