import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@mariozechner/pi-coding-agent'

import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import { FALLBACK_MODELS } from './fallback-models.ts'
import { connectToProxy, getActivePort, pushToken, readPortFile, stopHeartbeat } from './proxy-lifecycle.ts'
import {
  getEnvOverrides,
  resolveEffective,
  saveConfig,
  type CursorConfig,
  type ModelMappingsMode,
  type NativeToolsMode,
} from './proxy/config.ts'
import { initDebugLogger, logLifecycle } from './proxy/debug-logger.ts'
import { familyKey, parseModelId, processModels, type NormalizedModelSet } from './proxy/model-normalization.ts'
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

function toProviderModels(models: CursorModel[], modelSet?: NormalizedModelSet): ProviderModelConfig[] {
  return models.map((m) => {
    const base: ProviderModelConfig = {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: (m.supportsImages ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }

    // When normalized, set reasoning effort compat for models with effort maps
    if (modelSet) {
      const parsed = parseModelId(m.id)
      const fKey = familyKey(parsed.base, parsed.thinking, parsed.fast)
      const effortMap = modelSet.effortMaps.get(fKey)
      if (effortMap) {
        // reasoningEffortMap is a pi-cursor extension to the SDK compat type
        base.compat = {
          supportsReasoningEffort: true,
          reasoningEffortMap: effortMap,
        } as ProviderModelConfig['compat']
      }
    }

    return base
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
    const cfg = resolveEffective()
    let providerModels: ProviderModelConfig[]
    if (cfg.modelMappings === 'normalized' && models.length > 0) {
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
      type SettingKey = 'nativeToolsMode' | 'maxMode' | 'modelMappings' | 'maxRetries'
      interface SettingRow {
        key: SettingKey
        label: string
        display: string
        envLocked: boolean
      }

      function formatValue(key: SettingKey, cfg: CursorConfig): string {
        if (key === 'maxMode') {
          return cfg.maxMode ? 'on' : 'off'
        }
        return String(cfg[key])
      }

      const rows: SettingRow[] = []

      // Native Tools Mode
      rows.push({
        key: 'nativeToolsMode',
        label: 'Native Tools Mode',
        display: formatValue('nativeToolsMode', cfg),
        envLocked: 'nativeToolsMode' in envOverrides,
      })

      // Max Mode — hidden when modelMappings=raw
      if (cfg.modelMappings !== 'raw') {
        rows.push({
          key: 'maxMode',
          label: 'Max Mode',
          display: formatValue('maxMode', cfg),
          envLocked: 'maxMode' in envOverrides,
        })
      }

      // Model Mappings
      rows.push({
        key: 'modelMappings',
        label: 'Model Mappings',
        display: formatValue('modelMappings', cfg),
        envLocked: 'modelMappings' in envOverrides,
      })

      // Max Retries
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

      // Env-overridden settings are read-only
      if (row.envLocked) {
        const envVar = envOverrides[row.key]
        ctx.ui.notify(`${row.label} is overridden by ${envVar ?? 'environment variable'}`, 'warning')
        return
      }

      // Show value sub-menu
      const valueOptions: Record<SettingKey, string[]> = {
        nativeToolsMode: ['reject', 'redirect', 'native'],
        maxMode: ['on', 'off'],
        modelMappings: ['normalized', 'raw'],
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
        case 'modelMappings': {
          update.modelMappings = selectedValue as ModelMappingsMode
          break
        }
        case 'maxRetries': {
          update.maxRetries = Number.parseInt(selectedValue, 10)
          break
        }
      }

      // Persist
      saveConfig(update)

      // If modelMappings changed, re-register provider with new model processing
      if (row.key === 'modelMappings') {
        register()
      }

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
