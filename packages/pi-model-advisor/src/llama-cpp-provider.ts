import { readFile } from 'node:fs/promises'
import { findPackageJSON } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  AnyModel,
  ApiKeyCredential,
  AuthContext,
  AuthResult,
  ClassifierModel,
  Model,
  Provider,
  RefreshModelsContext,
} from '@earendil-works/pi-ai'
import type { llamaCppClassifyApi } from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy'
import type { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export const LLAMA_PROVIDER_ID = 'llama.cpp'
export const DEFAULT_LLAMA_SERVER_URL = 'http://127.0.0.1:8080'

type LlamaClassifierApi = 'llama-cpp-classify' | 'typesafe-system-one'
interface PiAiApiModuleMap {
  'llama-cpp-classify.lazy': { llamaCppClassifyApi: typeof llamaCppClassifyApi }
  'openai-completions.lazy': { openAICompletionsApi: typeof openAICompletionsApi }
  'typesafe-system-one.lazy': { typesafeSystemOneApi: typeof typesafeSystemOneApi }
}
interface LlamaModelInfo {
  id: string
  status: {
    value: string
    args?: string[]
    failed?: boolean
  }
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  source?: string
  meta?: {
    n_ctx?: number
    n_ctx_train?: number
  }
}

interface LlamaServerProps {
  models_autoload?: boolean
  chat_template?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Resolve host ESM exports by manifest; Jiti's Pi AI root alias misroutes bare `pi-ai/api/*` imports.
async function loadPiAiApiModules(): Promise<{
  classifier: ReturnType<PiAiApiModuleMap['llama-cpp-classify.lazy']['llamaCppClassifyApi']>
  chat: ReturnType<PiAiApiModuleMap['openai-completions.lazy']['openAICompletionsApi']>
  systemOne: ReturnType<PiAiApiModuleMap['typesafe-system-one.lazy']['typesafeSystemOneApi']>
}> {
  const { getPackageDir } = await import('@earendil-works/pi-coding-agent')
  const hostPackageJson = pathToFileURL(join(getPackageDir(), 'package.json')).href
  const piAiPackageJson = findPackageJSON('@earendil-works/pi-ai', hostPackageJson)
  if (!piAiPackageJson) {
    throw new Error('Unable to locate Pi’s public @earendil-works/pi-ai package')
  }
  const manifest: unknown = JSON.parse(await readFile(piAiPackageJson, 'utf8'))
  const apiExports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports['./api/*'] : undefined
  const importTarget = isRecord(apiExports) ? apiExports.import : undefined
  if (typeof importTarget !== 'string' || !importTarget.startsWith('./') || importTarget.split('*').length !== 2) {
    throw new Error('Pi’s @earendil-works/pi-ai package does not expose public ESM API subpaths')
  }

  const packageDir = dirname(piAiPackageJson)
  const resolveExport = (specifier: keyof PiAiApiModuleMap): string => {
    const target = resolve(packageDir, importTarget.replace('*', specifier))
    const relativeTarget = relative(packageDir, target)
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new Error(`Invalid @earendil-works/pi-ai public export target for ${specifier}`)
    }
    return pathToFileURL(target).href
  }

  const [classifierModule, chatModule, systemOneModule] = await Promise.all([
    import(resolveExport('llama-cpp-classify.lazy')) as Promise<PiAiApiModuleMap['llama-cpp-classify.lazy']>,
    import(resolveExport('openai-completions.lazy')) as Promise<PiAiApiModuleMap['openai-completions.lazy']>,
    import(resolveExport('typesafe-system-one.lazy')) as Promise<PiAiApiModuleMap['typesafe-system-one.lazy']>,
  ])
  return {
    classifier: classifierModule.llamaCppClassifyApi(),
    chat: chatModule.openAICompletionsApi(),
    systemOne: systemOneModule.typesafeSystemOneApi(),
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function hasValidArchitecture(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  const { architecture } = value
  if (architecture === undefined) {
    return true
  }
  if (!isRecord(architecture)) {
    return false
  }
  return (
    (architecture.input_modalities === undefined || isStringArray(architecture.input_modalities)) &&
    (architecture.output_modalities === undefined || isStringArray(architecture.output_modalities))
  )
}

function isLlamaModelInfo(value: unknown): value is LlamaModelInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRecord(value.status) &&
    typeof value.status.value === 'string' &&
    (value.status.args === undefined || isStringArray(value.status.args)) &&
    hasValidArchitecture(value)
  )
}

function responseError(payload: unknown, fallback: string): string {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return fallback
  }
  return typeof payload.error.message === 'string' && payload.error.message ? payload.error.message : fallback
}

export function normalizeLlamaServerUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server URL must use http or https')
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/u, '').replace(/(?:\/v1)+$/u, '') || '/'
  return url.toString().replace(/\/$/u, '')
}

export function llamaInferenceUrl(serverUrl: string): string {
  return `${normalizeLlamaServerUrl(serverUrl)}/v1`
}

class LlamaReadOnlyClient {
  readonly serverUrl: string

  constructor(
    serverUrl: string,
    private readonly apiKey?: string,
  ) {
    this.serverUrl = normalizeLlamaServerUrl(serverUrl)
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    const headers = new Headers()
    if (this.apiKey) {
      headers.set('Authorization', `Bearer ${this.apiKey}`)
    }
    const timeout = AbortSignal.timeout(15_000)
    const requestSignal = AbortSignal.any([signal, timeout])
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: 'GET',
      headers,
      signal: requestSignal,
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(responseError(payload, `llama.cpp returned HTTP ${response.status}`))
    }
    return payload
  }

  async list(signal: AbortSignal): Promise<LlamaModelInfo[]> {
    const payload = await this.get('/models', signal)
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error('llama.cpp returned an invalid model catalog')
    }
    if (!payload.data.every(isLlamaModelInfo)) {
      throw new Error('llama.cpp returned invalid architecture metadata or model status')
    }
    return payload.data
  }

  async props(options: { model?: string; signal: AbortSignal }): Promise<LlamaServerProps> {
    const query = options.model ? `?${new URLSearchParams({ model: options.model, autoload: 'false' })}` : ''
    const payload = await this.get(`/props${query}`, options.signal)
    if (!isRecord(payload)) {
      return {}
    }
    return {
      ...(typeof payload.models_autoload === 'boolean' ? { models_autoload: payload.models_autoload } : {}),
      ...(typeof payload.chat_template === 'string' ? { chat_template: payload.chat_template } : {}),
    }
  }
}

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
  const value = credential?.env?.LLAMA_BASE_URL
  return typeof value === 'string' && value.trim() ? normalizeLlamaServerUrl(value) : undefined
}

async function resolveServerUrl(
  ctx: AuthContext,
  credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
  const configured = credentialServerUrl(credential) ?? (await ctx.env('LLAMA_BASE_URL'))?.trim()
  return configured ? normalizeLlamaServerUrl(configured) : undefined
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
  if (model.status.value === 'loaded' || model.status.value === 'sleeping') {
    return true
  }
  return routerAutoload && model.status.value === 'unloaded' && !model.status.failed && model.source === 'preset'
}

async function routerAutoloadEnabled(
  client: LlamaReadOnlyClient,
  catalog: readonly LlamaModelInfo[],
  signal: AbortSignal,
): Promise<boolean> {
  if (!catalog.some((model) => model.status.value === 'unloaded' && model.source === 'preset')) {
    return false
  }
  try {
    return (await client.props({ signal })).models_autoload === true
  } catch {
    return false
  }
}

function modelHasChatOutput(model: LlamaModelInfo): boolean {
  const outputModalities = model.architecture?.output_modalities
  return !outputModalities?.includes('decisions') || outputModalities.includes('text')
}

function isValidTokenLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function configuredContextWindow(model: LlamaModelInfo): number | undefined {
  const args = model.status.args ?? []
  if (!isStringArray(args)) {
    return undefined
  }
  for (let index = 0; index < args.length - 1; index++) {
    const flag = args[index]
    if (flag !== '--ctx-size' && flag !== '-c' && flag !== '-ctx') {
      continue
    }
    const contextWindow = Number(args[index + 1])
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
      return contextWindow
    }
  }
  return undefined
}

function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number {
  const runtimeContextWindow = model.meta?.n_ctx
  if (isValidTokenLimit(runtimeContextWindow)) {
    return runtimeContextWindow
  }
  const configuredContext = configuredContextWindow(model)
  if (configuredContext) {
    return configuredContext
  }
  if (isValidTokenLimit(cachedContextWindow)) {
    return cachedContextWindow
  }
  const trainingContextWindow = model.meta?.n_ctx_train
  return isValidTokenLimit(trainingContextWindow) ? trainingContextWindow : 128_000
}

function toPiClassifierModel(
  model: LlamaModelInfo,
  serverUrl: string,
  cachedContextWindow?: number,
): ClassifierModel<LlamaClassifierApi> {
  const isSystemOneModel = model.architecture?.output_modalities?.includes('decisions') === true
  return {
    type: 'classifier',
    id: model.id,
    name: model.id,
    api: isSystemOneModel ? 'typesafe-system-one' : 'llama-cpp-classify',
    provider: LLAMA_PROVIDER_ID,
    baseUrl: isSystemOneModel ? llamaInferenceUrl(serverUrl) : normalizeLlamaServerUrl(serverUrl),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowOf(model, cachedContextWindow),
  }
}

function toPiModel(
  model: LlamaModelInfo,
  serverUrl: string,
  props?: LlamaServerProps,
  cachedContextWindow?: number,
): Model<'openai-completions'> {
  const contextWindow = contextWindowOf(model, cachedContextWindow)
  const reasoning = props?.chat_template?.includes('enable_thinking') === true
  return {
    id: model.id,
    name: model.id,
    api: 'openai-completions',
    provider: LLAMA_PROVIDER_ID,
    baseUrl: llamaInferenceUrl(serverUrl),
    reasoning,
    ...(reasoning && {
      thinkingLevelMap: { off: 'off', minimal: null, low: null, medium: 'medium', high: null, xhigh: null },
    }),
    input: model.architecture?.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: contextWindow,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      ...(reasoning && { thinkingFormat: 'qwen-chat-template' }),
    },
  }
}

function restoreCatalog(stored: readonly AnyModel[]): {
  models: Model<'openai-completions'>[]
  classifiers: ClassifierModel<LlamaClassifierApi>[]
} {
  const providerModels = stored.filter(
    (model): model is Model<'openai-completions'> | ClassifierModel<LlamaClassifierApi> =>
      model.provider === LLAMA_PROVIDER_ID &&
      (model.api === 'openai-completions' || model.api === 'llama-cpp-classify' || model.api === 'typesafe-system-one'),
  )
  const models: Model<'openai-completions'>[] = []
  const classifiers: ClassifierModel<LlamaClassifierApi>[] = []
  for (const model of providerModels) {
    if (model.api === 'openai-completions') {
      const contextWindow = isValidTokenLimit(model.contextWindow) ? model.contextWindow : 128_000
      models.push({
        ...model,
        baseUrl: llamaInferenceUrl(model.baseUrl),
        contextWindow,
        maxTokens: isValidTokenLimit(model.maxTokens) ? model.maxTokens : contextWindow,
      })
    } else if (model.api === 'typesafe-system-one') {
      classifiers.push({
        ...model,
        baseUrl: llamaInferenceUrl(model.baseUrl),
        contextWindow: isValidTokenLimit(model.contextWindow) ? model.contextWindow : 128_000,
      })
    } else {
      classifiers.push({
        ...model,
        baseUrl: normalizeLlamaServerUrl(model.baseUrl),
        contextWindow: isValidTokenLimit(model.contextWindow) ? model.contextWindow : 128_000,
      })
    }
  }
  return { models, classifiers }
}

export interface LlamaCppProviderController {
  provider: Provider<'openai-completions'>
  setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void
}

export async function createLlamaCppProvider(): Promise<LlamaCppProviderController> {
  const { classifier, chat, systemOne } = await loadPiAiApiModules()
  let models: readonly Model<'openai-completions'>[] = []
  let classifiers: readonly ClassifierModel<LlamaClassifierApi>[] = []

  const setCatalog = (
    catalog: readonly LlamaModelInfo[],
    serverUrl: string,
    options: { routerAutoload?: boolean } = {},
  ): void => {
    const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true))
    models = selectable.filter(modelHasChatOutput).map((model) => toPiModel(model, serverUrl))
    classifiers = selectable.map((model) => toPiClassifierModel(model, serverUrl))
  }

  const provider: Provider<'openai-completions'> = {
    id: LLAMA_PROVIDER_ID,
    name: 'llama.cpp',
    baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
    auth: {
      apiKey: {
        name: 'llama.cpp server',
        login: async (interaction) => {
          const enteredUrl = await interaction.prompt({
            type: 'text',
            message: 'llama.cpp server URL',
            placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
          })
          let serverUrlInput = enteredUrl.trim()
          if (serverUrlInput.length === 0) {
            serverUrlInput = process.env.LLAMA_BASE_URL?.trim() ?? ''
          }
          if (serverUrlInput.length === 0) {
            serverUrlInput = DEFAULT_LLAMA_SERVER_URL
          }
          const serverUrl = normalizeLlamaServerUrl(serverUrlInput)
          const apiKey = (
            await interaction.prompt({
              type: 'secret',
              message: 'API key (optional)',
            })
          ).trim()
          const optionalApiKey = apiKey.length > 0 ? apiKey : undefined
          await new LlamaReadOnlyClient(serverUrl, optionalApiKey).list(interaction.signal)
          return { type: 'api_key', key: optionalApiKey, env: { LLAMA_BASE_URL: serverUrl } }
        },
        check: async ({ ctx, credential }) => {
          const serverUrl = await resolveServerUrl(ctx, credential)
          if (!serverUrl) {
            return undefined
          }
          return {
            type: 'api_key',
            source: credentialServerUrl(credential) ? 'stored credential' : 'LLAMA_BASE_URL',
          }
        },
        resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
          const serverUrl = await resolveServerUrl(ctx, credential)
          if (!serverUrl) {
            return undefined
          }
          const apiKey = credential?.key ?? (await ctx.env('LLAMA_API_KEY')) ?? 'local'
          return {
            auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
            env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
            source: credentialServerUrl(credential) ? 'stored credential' : 'LLAMA_BASE_URL',
          }
        },
      },
    },
    getModels: () => models,
    getAllModels: () => [...models, ...classifiers],
    refreshModels: async (context: RefreshModelsContext): Promise<void> => {
      const cachedContextWindows = new Map<string, number>()
      if (context.stored) {
        const { models: restoredModels, classifiers: restoredClassifiers } = restoreCatalog(context.stored.models)
        for (const model of context.stored.models) {
          if (
            model.provider === LLAMA_PROVIDER_ID &&
            (model.api === 'openai-completions' ||
              model.api === 'llama-cpp-classify' ||
              model.api === 'typesafe-system-one') &&
            'contextWindow' in model &&
            isValidTokenLimit(model.contextWindow)
          ) {
            cachedContextWindows.set(model.id, model.contextWindow)
          }
        }
        if (
          !(await context.publish({
            update: () => {
              models = restoredModels
              classifiers = restoredClassifiers
            },
          }))
        ) {
          return
        }
      }

      if (!context.allowNetwork || isAborted(context.signal) || context.credential?.type !== 'api_key') {
        return
      }
      const serverUrl = credentialServerUrl(context.credential)
      if (!serverUrl) {
        return
      }
      const client = new LlamaReadOnlyClient(serverUrl, context.credential.key)
      const catalog = await client.list(context.signal)
      if (isAborted(context.signal)) {
        return
      }
      const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal)
      if (isAborted(context.signal)) {
        return
      }
      const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload))
      const refreshed = await Promise.all(
        selectable.filter(modelHasChatOutput).map(async (model) => {
          const cachedContextWindow = cachedContextWindows.get(model.id)
          // Only loaded models expose chat templates without waking or loading them.
          if (model.status.value !== 'loaded') {
            return toPiModel(model, serverUrl, undefined, cachedContextWindow)
          }
          const props = await client.props({ model: model.id, signal: context.signal })
          return toPiModel(model, serverUrl, props, cachedContextWindow)
        }),
      )
      const refreshedClassifiers = selectable.map((model) =>
        toPiClassifierModel(model, serverUrl, cachedContextWindows.get(model.id)),
      )
      if (isAborted(context.signal)) {
        return
      }
      await context.publish({
        persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
        update: () => {
          models = refreshed
          classifiers = refreshedClassifiers
        },
      })
    },
    stream: (model, context, options) => chat.stream(model, context, options),
    streamSimple: (model, context, options) => chat.streamSimple(model, context, options),
    classify: (model, context, options) =>
      model.api === 'typesafe-system-one'
        ? systemOne.classify(model, context, options)
        : classifier.classify(model, context, options),
  }

  return { provider, setCatalog }
}

/** Register this provider only from an explicitly loaded optional extension shim. */
export default async function registerLlamaCppProviderExtension(pi: ExtensionAPI): Promise<void> {
  const { provider } = await createLlamaCppProvider()
  pi.on('session_start', () => pi.registerProvider(provider))
  pi.on('session_shutdown', (_event, context) => {
    // Native providers outlive extension factories; only remove the instance this extension registered.
    if (context.modelRegistry.getRegisteredNativeProvider(LLAMA_PROVIDER_ID) === provider) {
      pi.unregisterProvider(LLAMA_PROVIDER_ID)
    }
  })
}
