import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AuthContext,
  type ModelsPublication,
  type ModelsStoreEntry,
  type RefreshModelsContext,
} from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import {
  createAgentSession,
  DefaultResourceLoader,
  getPackageDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'
import { build } from 'rolldown'
import { loadConfig } from 'rolldown/config'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLlamaCppProvider,
  llamaInferenceUrl,
  LLAMA_PROVIDER_ID,
  normalizeLlamaServerUrl,
} from './llama-cpp-provider.ts'

const temporaryDirectories: string[] = []
const servers: Server[] = []

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof Request) {
    return input.url
  }
  return input.href
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') {
    return body
  }
  if (body instanceof URLSearchParams) {
    return body.toString()
  }
  throw new Error('Expected a string test request body')
}

function refreshContext(
  options: {
    credential?: RefreshModelsContext['credential']
    stored?: ModelsStoreEntry
    allowNetwork?: boolean
    signal?: AbortSignal
    publish?: RefreshModelsContext['publish']
  } = {},
): RefreshModelsContext {
  return {
    credential: options.credential,
    stored: options.stored,
    publish:
      options.publish ??
      ((publication: ModelsPublication) => {
        publication.update?.()
        return Promise.resolve(true)
      }),
    allowNetwork: options.allowNetwork ?? false,
    signal: options.signal ?? new AbortController().signal,
  }
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-model-advisor-llama-cpp-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    ),
  )
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('optional llama.cpp provider extension', () => {
  it('uses Pi’s real built-in factory, dispatches through the registered runtime, and restores it on reload', async () => {
    vi.stubEnv('LLAMA_BASE_URL', '')
    vi.stubEnv('LLAMA_API_KEY', '')

    const catalog = [
      {
        id: 'chat-model',
        status: { value: 'loaded' },
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        meta: { n_ctx: 8192 },
      },
      {
        id: 'decoder-model',
        status: { value: 'loaded' },
        architecture: { output_modalities: ['text'] },
        meta: { n_ctx: 4096 },
      },
      {
        id: 'decision-model',
        status: { value: 'loaded' },
        architecture: { output_modalities: ['decisions'] },
        meta: { n_ctx: 4096 },
      },
    ]
    const chatChunks = [
      {
        id: 'runtime-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'runtime-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'runtime-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ]
    const chatFrames = [...chatChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
    const requests: {
      method: string
      path: string
      authorization: string | undefined
      payload?: Record<string, unknown>
    }[] = []
    const localServer = await listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = `${url.pathname}${url.search}`
      const method = request.method ?? 'GET'
      if (method === 'GET') {
        requests.push({ method, path, authorization: request.headers.authorization })
        if (url.pathname === '/prefix/models') {
          sendJson(response, { data: catalog })
        } else if (url.pathname === '/prefix/props') {
          sendJson(response, { chat_template: '{% if enable_thinking %}think{% endif %}' })
        } else {
          response.writeHead(404).end()
        }
        return
      }

      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        requests.push({ method, path, authorization: request.headers.authorization, payload })
        if (path === '/prefix/v1/systemone') {
          sendJson(response, {
            answers: {
              kind: {
                type: 'choice',
                choice: 'routine',
                probabilities: { routine: 0.9, urgent: 0.1 },
                confidence: 0.8,
              },
            },
            usage: { input_tokens: 42, output_tokens: 3 },
          })
        } else if (path === '/prefix/tokenize') {
          sendJson(response, { tokens: Array.from(String(payload.content), (character) => character.codePointAt(0)) })
        } else if (path === '/prefix/apply-template') {
          sendJson(response, { prompt: '<|im_start|>assistant\n' })
        } else if (path === '/prefix/completion') {
          sendJson(response, {
            completion_probabilities: [
              {
                top_logprobs: [
                  { id: 65, token: 'A', logprob: -0.1 },
                  { id: 66, token: 'B', logprob: -2.4 },
                ],
              },
            ],
          })
        } else if (path === '/prefix/v1/chat/completions') {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(chatFrames)
        } else {
          response.writeHead(404).end()
        }
      })
    })
    const serverUrl = `${localServer}/prefix`

    const workspace = createTemporaryDirectory()
    const cwd = join(workspace, 'project')
    const agentDir = join(workspace, 'agent')
    const extensionsDir = join(agentDir, 'extensions')
    const installedPackage = join(agentDir, 'npm', 'node_modules', '@schultzp2020', 'pi-model-advisor')
    const fixtureDist = join(workspace, 'fixture-dist')
    const packageDir = fileURLToPath(new URL('..', import.meta.url))
    const packageDist = resolve(packageDir, 'dist')
    const loadedConfig = await loadConfig(fileURLToPath(new URL('../rolldown.config.ts', import.meta.url)))
    if (typeof loadedConfig === 'function' || Array.isArray(loadedConfig)) {
      throw new Error('Expected one published Rolldown config')
    }
    const { input, output } = loadedConfig
    if (!input || typeof input !== 'object' || Array.isArray(input) || !output || Array.isArray(output)) {
      throw new Error('Expected one input map and one output in the published Rolldown config')
    }
    const absoluteInput = Object.fromEntries(
      Object.entries(input).map(([name, entry]) => {
        if (typeof entry !== 'string') {
          throw new Error(`Expected a single input file for ${name}`)
        }
        return [name, resolve(packageDir, entry)]
      }),
    )
    expect(absoluteInput['llama-cpp-provider']).toBe(resolve(packageDir, 'src/llama-cpp-provider.ts'))
    expect(fixtureDist).not.toBe(packageDist)
    const fixture = await build({
      ...loadedConfig,
      input: absoluteInput,
      output: { ...output, dir: fixtureDist },
      write: true,
    })
    if (!fixture.output.some((item) => item.type === 'chunk' && item.fileName === 'llama-cpp-provider.js')) {
      throw new Error('Published Rolldown config did not emit the optional provider entry')
    }
    mkdirSync(cwd)
    mkdirSync(extensionsDir, { recursive: true })
    cpSync(fixtureDist, join(installedPackage, 'dist'), { recursive: true })
    const shimPath = join(extensionsDir, 'llama-cpp-provider.ts')
    const writeShim = (): void => {
      writeFileSync(
        shimPath,
        "import llamaCppProvider from '../npm/node_modules/@schultzp2020/pi-model-advisor/dist/llama-cpp-provider.js'\nexport default llamaCppProvider\n",
      )
    }
    writeShim()
    const builtinPath = 'builtin:llama.cpp'
    const settingsManager = SettingsManager.create(cwd, agentDir)
    settingsManager.setExtensionPaths([builtinPath])
    const credentials = new InMemoryCredentialStore()
    await credentials.modify(LLAMA_PROVIDER_ID, () =>
      Promise.resolve({
        type: 'api_key',
        key: 'runtime-secret',
        env: { LLAMA_BASE_URL: serverUrl },
      }),
    )
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    })

    const builtinFactoryPath = pathToFileURL(join(getPackageDir(), 'dist/extensions/llama/index.js')).href
    const builtinFactoryModule = (await import(builtinFactoryPath)) as { default: ExtensionFactory }
    const builtinProvider: InlineExtension = {
      name: 'llama.cpp',
      builtin: true,
      factory: builtinFactoryModule.default,
    }
    let shutdownObserverCalls = 0
    const shutdownObserver: ExtensionFactory = (pi) => {
      pi.on('session_shutdown', () => {
        shutdownObserverCalls++
      })
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [shimPath],
      extensionFactories: [builtinProvider, shutdownObserver],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      noTools: 'all',
    })
    const builtin = modelRuntime.getRegisteredNativeProvider(LLAMA_PROVIDER_ID)
    if (!builtin) {
      session.dispose()
      throw new Error('Pi’s built-in llama.cpp provider was not registered')
    }
    expect(builtin.name).toBe('llama.cpp')
    expect(typeof builtin.stream).toBe('function')

    try {
      await session.bindExtensions({ shutdownHandler: () => undefined })
      expect(resourceLoader.getExtensions().errors).toEqual([])
      expect(resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(shimPath)
      const registered = modelRuntime.getRegisteredNativeProvider(LLAMA_PROVIDER_ID)
      expect(registered).toBeDefined()
      expect(registered).not.toBe(builtin)
      expect(registered).toBe(modelRuntime.getProvider(LLAMA_PROVIDER_ID))
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === LLAMA_PROVIDER_ID)).toEqual([
        LLAMA_PROVIDER_ID,
      ])
      expect(shutdownObserverCalls).toBe(0)

      const refreshResult = await modelRuntime.refresh({
        providers: [LLAMA_PROVIDER_ID],
        allowNetwork: true,
        force: true,
      })
      expect(refreshResult.aborted).toBeFalsy()
      expect(refreshResult.errors.get(LLAMA_PROVIDER_ID)).toBeUndefined()

      const decisionModel = modelRuntime.getModelOfType('classifier', LLAMA_PROVIDER_ID, 'decision-model')
      const decoderModel = modelRuntime.getModelOfType('classifier', LLAMA_PROVIDER_ID, 'decoder-model')
      const chatModel = modelRuntime.getModel(LLAMA_PROVIDER_ID, 'chat-model')
      if (!decisionModel || !decoderModel || !chatModel) {
        throw new Error('Managed provider catalog did not expose all fixture models')
      }
      expect(decisionModel.api).toBe('typesafe-system-one')
      expect(decoderModel.api).toBe('llama-cpp-classify')

      const systemOneResult = await modelRuntime.classify(decisionModel, {
        state: { message: 'Approve routine change' },
        questions: {
          kind: {
            type: 'choice',
            instructions: 'Classify',
            criteria: { routine: 'Routine', urgent: 'Urgent' },
          },
        },
      })
      expect(systemOneResult.stopReason).toBe('stop')
      expect(systemOneResult.answers.kind).toMatchObject({ type: 'choice', choice: 'routine' })

      const decoderResult = await modelRuntime.classify(decoderModel, {
        state: { message: 'The build failed.' },
        questions: {
          kind: {
            type: 'choice',
            instructions: 'What failed?',
            criteria: { billing: 'Billing', ci: 'CI' },
          },
        },
      })
      expect(decoderResult.stopReason).toBe('stop')
      expect(decoderResult.answers.kind).toMatchObject({ type: 'choice', choice: 'billing' })

      const chatEvents = []
      for await (const event of modelRuntime.streamSimple(
        chatModel,
        normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] }),
      )) {
        chatEvents.push(event)
      }
      const chatDone = chatEvents.find((event) => event.type === 'done')
      expect(chatDone?.message.content).toContainEqual({ type: 'text', text: 'Hello' })
      expect(chatDone?.message.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 })

      const dispatches = requests.filter((request) => request.method === 'POST')
      expect(dispatches.map((request) => request.path)).toEqual(
        expect.arrayContaining([
          '/prefix/v1/systemone',
          '/prefix/tokenize',
          '/prefix/apply-template',
          '/prefix/completion',
          '/prefix/v1/chat/completions',
        ]),
      )
      expect(dispatches.every((request) => request.authorization === 'Bearer runtime-secret')).toBeTruthy()
      expect(dispatches.find((request) => request.path === '/prefix/v1/systemone')?.payload).toMatchObject({
        model: 'decision-model',
      })
      expect(dispatches.find((request) => request.path === '/prefix/completion')?.payload).toMatchObject({
        model: 'decoder-model',
        n_predict: 1,
      })
      expect(dispatches.find((request) => request.path === '/prefix/v1/chat/completions')?.payload).toMatchObject({
        model: 'chat-model',
      })

      rmSync(shimPath, { force: true })
      await session.reload()
      const restored = modelRuntime.getRegisteredNativeProvider(LLAMA_PROVIDER_ID)
      expect(restored).toBeDefined()
      expect(restored).not.toBe(registered)
      expect(restored?.name).toBe('llama.cpp')
      expect(typeof restored?.stream).toBe('function')
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === LLAMA_PROVIDER_ID)).toEqual([
        LLAMA_PROVIDER_ID,
      ])
      expect(shutdownObserverCalls).toBe(1)

      writeShim()
      await session.reload()
      const finalProvider = modelRuntime.getRegisteredNativeProvider(LLAMA_PROVIDER_ID)
      expect(finalProvider).toBeDefined()
      expect(finalProvider).not.toBe(restored)
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === LLAMA_PROVIDER_ID)).toEqual([
        LLAMA_PROVIDER_ID,
      ])
      expect(shutdownObserverCalls).toBe(2)

      rmSync(shimPath, { force: true })
      await session.reload()
      const finalRestored = modelRuntime.getRegisteredNativeProvider(LLAMA_PROVIDER_ID)
      expect(finalRestored).toBeDefined()
      expect(finalRestored).not.toBe(finalProvider)
      expect(finalRestored?.name).toBe('llama.cpp')
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === LLAMA_PROVIDER_ID)).toEqual([
        LLAMA_PROVIDER_ID,
      ])
      expect(shutdownObserverCalls).toBe(3)
    } finally {
      session.dispose()
    }
  })

  it('creates a complete llama.cpp native provider with an initially empty dynamic catalog', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const { provider } = await createLlamaCppProvider()

    expect(fetch).not.toHaveBeenCalled()
    expect(provider.id).toBe(LLAMA_PROVIDER_ID)
    expect(provider.name).toBe('llama.cpp')
    expect(provider.getModels()).toEqual([])
    expect(provider.getAllModels?.()).toEqual([])
    expect(typeof provider.refreshModels).toBe('function')
    expect(typeof provider.stream).toBe('function')
    expect(typeof provider.streamSimple).toBe('function')
    expect(typeof provider.classify).toBe('function')
  })

  it('preserves router path prefixes and sends read-only catalog requests to the management root', async () => {
    const catalog: unknown[] = [
      {
        id: 'clef-no-decisions',
        status: { value: 'loaded' },
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        meta: { n_ctx: 8192 },
      },
      {
        id: 'unrelated-decision-model',
        status: { value: 'loaded' },
        architecture: { output_modalities: ['decisions'] },
        meta: { n_ctx: 4096 },
      },
      {
        id: 'mixed-output',
        status: { value: 'loaded' },
        architecture: { output_modalities: ['text', 'decisions'] },
        meta: { n_ctx: 16384 },
      },
      { id: 'sleeping', status: { value: 'sleeping', args: ['llama-server', '-c', '2048'] } },
      {
        id: 'autoload-preset',
        status: { value: 'unloaded', args: ['llama-server', '--ctx-size', '65536'] },
        source: 'preset',
      },
      { id: 'failed-preset', status: { value: 'unloaded', failed: true }, source: 'preset' },
      { id: 'unloaded-cache', status: { value: 'unloaded' }, source: 'cache' },
      { id: 'loading', status: { value: 'loading' } },
    ]
    const requests: { path: string; authorization: string | undefined }[] = []
    const root = await listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      requests.push({ path: `${url.pathname}${url.search}`, authorization: request.headers.authorization })
      if (url.pathname === '/prefix/models' && request.method === 'GET') {
        sendJson(response, { data: catalog })
      } else if (url.pathname === '/prefix/props' && request.method === 'GET') {
        sendJson(
          response,
          url.searchParams.has('model')
            ? { chat_template: '{% if enable_thinking %}think{% endif %}' }
            : { models_autoload: true },
        )
      } else {
        response.writeHead(404).end()
      }
    })
    const controller = await createLlamaCppProvider()
    const stored: ModelsStoreEntry[] = []
    const credential = {
      type: 'api_key' as const,
      key: 'secret',
      env: { LLAMA_BASE_URL: `${root}/prefix/v1/` },
    }

    await controller.provider.refreshModels?.(
      refreshContext({
        credential,
        allowNetwork: true,
        publish: (publication) => {
          if (publication.persist) {
            stored.push(structuredClone(publication.persist))
          }
          publication.update?.()
          return Promise.resolve(true)
        },
      }),
    )

    expect(requests.map((request) => request.path)).toContain('/prefix/models')
    expect(requests.map((request) => request.path)).toContain('/prefix/props')
    expect(requests.filter((request) => request.path.startsWith('/prefix/props?')).length).toBe(2)
    expect(requests.every((request) => request.authorization === 'Bearer secret')).toBeTruthy()
    expect(controller.provider.getModels().map((model) => model.id)).toEqual([
      'clef-no-decisions',
      'mixed-output',
      'sleeping',
      'autoload-preset',
    ])
    expect(controller.provider.getModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'clef-no-decisions',
          baseUrl: `${root}/prefix/v1`,
          input: ['text', 'image'],
          contextWindow: 8192,
          maxTokens: 8192,
          reasoning: true,
        }),
        expect.objectContaining({ id: 'autoload-preset', contextWindow: 65536, maxTokens: 65536 }),
      ]),
    )
    expect(
      controller.provider
        .getAllModels?.()
        .filter((model) => model.type === 'classifier')
        .map((model) => [model.id, model.api, model.baseUrl, model.input]),
    ).toEqual([
      ['clef-no-decisions', 'llama-cpp-classify', `${root}/prefix`, ['text']],
      ['unrelated-decision-model', 'typesafe-system-one', `${root}/prefix/v1`, ['text']],
      ['mixed-output', 'typesafe-system-one', `${root}/prefix/v1`, ['text']],
      ['sleeping', 'llama-cpp-classify', `${root}/prefix`, ['text']],
      ['autoload-preset', 'llama-cpp-classify', `${root}/prefix`, ['text']],
    ])
    expect(stored[0]?.models.map((model) => [model.id, model.api])).toEqual([
      ['clef-no-decisions', 'openai-completions'],
      ['mixed-output', 'openai-completions'],
      ['sleeping', 'openai-completions'],
      ['autoload-preset', 'openai-completions'],
      ['clef-no-decisions', 'llama-cpp-classify'],
      ['unrelated-decision-model', 'typesafe-system-one'],
      ['mixed-output', 'typesafe-system-one'],
      ['sleeping', 'llama-cpp-classify'],
      ['autoload-preset', 'llama-cpp-classify'],
    ])
    const restored = await createLlamaCppProvider()
    await restored.provider.refreshModels?.(refreshContext({ stored: stored[0], allowNetwork: false }))
    expect(
      restored.provider
        .getAllModels?.()
        .filter((model) => model.type === 'classifier')
        .map((model) => [model.id, model.api, model.baseUrl]),
    ).toEqual([
      ['clef-no-decisions', 'llama-cpp-classify', `${root}/prefix`],
      ['unrelated-decision-model', 'typesafe-system-one', `${root}/prefix/v1`],
      ['mixed-output', 'typesafe-system-one', `${root}/prefix/v1`],
      ['sleeping', 'llama-cpp-classify', `${root}/prefix`],
      ['autoload-preset', 'llama-cpp-classify', `${root}/prefix`],
    ])
    expect(normalizeLlamaServerUrl(`${root}/prefix/v1/`)).toBe(`${root}/prefix`)
    expect(llamaInferenceUrl(`${root}/prefix/v1/`)).toBe(`${root}/prefix/v1`)
    expect(() => normalizeLlamaServerUrl('file:///tmp/llama')).toThrow('http or https')
  })

  it('uses decisions metadata rather than model names and keeps decision-only models out of chat', async () => {
    const controller = await createLlamaCppProvider()
    controller.setCatalog(
      [
        { id: 'clef-ordinary', status: { value: 'loaded' }, architecture: { output_modalities: ['text'] } },
        { id: 'unrelated-decision', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions'] } },
        { id: 'mixed', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions', 'text'] } },
        { id: 'unknown-output', status: { value: 'loaded' }, architecture: { output_modalities: ['audio'] } },
      ],
      'http://127.0.0.1:8080/v1',
    )

    expect(controller.provider.getModels().map((model) => model.id)).toEqual([
      'clef-ordinary',
      'mixed',
      'unknown-output',
    ])
    expect(
      controller.provider
        .getAllModels?.()
        .filter((model) => model.type === 'classifier')
        .map((model) => [model.id, model.api]),
    ).toEqual([
      ['clef-ordinary', 'llama-cpp-classify'],
      ['unrelated-decision', 'typesafe-system-one'],
      ['mixed', 'typesafe-system-one'],
      ['unknown-output', 'llama-cpp-classify'],
    ])
  })

  it('stays dormant until configured and stores a normalized URL plus an optional key', async () => {
    const { provider } = await createLlamaCppProvider()
    const auth = provider.auth.apiKey
    if (!auth) {
      throw new Error('missing llama.cpp API key authentication')
    }
    if (!auth.login) {
      throw new Error('missing llama.cpp API key login')
    }
    const { signal } = new AbortController()
    const emptyContext: AuthContext = {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    }
    expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined()
    expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined()

    const root = await listen((request, response) => {
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/prefix/models')
      expect(request.headers.authorization).toBe('Bearer secret')
      sendJson(response, { data: [] })
    })
    const answers = [`${root}/prefix/v1/`, ' secret ']
    const credential = await auth.login({
      signal,
      prompt: () => {
        const answer = answers.shift()
        if (answer === undefined) {
          return Promise.reject(new Error('unexpected login prompt'))
        }
        return Promise.resolve(answer)
      },
      notify: () => undefined,
    })
    expect(credential).toEqual({ type: 'api_key', key: 'secret', env: { LLAMA_BASE_URL: `${root}/prefix` } })
    expect(
      await auth.resolve({
        ctx: emptyContext,
        credential,
        signal,
      }),
    ).toEqual({
      auth: { apiKey: 'secret', baseUrl: `${root}/prefix/v1` },
      env: { LLAMA_BASE_URL: `${root}/prefix` },
      source: 'stored credential',
    })

    const ambientValues: Record<string, string> = {
      LLAMA_BASE_URL: `${root}/ambient/v1`,
      LLAMA_API_KEY: 'environment-key',
    }
    const ambientContext: AuthContext = {
      env: (name) => Promise.resolve(ambientValues[name]),
      fileExists: () => Promise.resolve(false),
    }
    expect(await auth.check?.({ ctx: ambientContext, signal })).toEqual({
      type: 'api_key',
      source: 'LLAMA_BASE_URL',
    })
    expect(await auth.resolve({ ctx: ambientContext, signal })).toMatchObject({
      auth: { apiKey: 'environment-key', baseUrl: `${root}/ambient/v1` },
      env: { LLAMA_BASE_URL: `${root}/ambient` },
      source: 'LLAMA_BASE_URL',
    })
  })

  it('restores cached chat and classifier catalogs offline without changing inference roots', async () => {
    const root = await listen((_request, response) => {
      response.writeHead(500).end()
    })
    const source = await createLlamaCppProvider()
    source.setCatalog(
      [
        { id: 'cached-decision', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions'] } },
        { id: 'cached-decoder', status: { value: 'loaded' } },
      ],
      `${root}/prefix/v1`,
    )
    const stored: ModelsStoreEntry = {
      models:
        source.provider.getAllModels?.().map((model) => {
          if (model.id !== 'cached-decision') {
            return model
          }
          return { ...model, baseUrl: `${root}/prefix/v1/v1/` }
        }) ?? [],
    }
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const restored = await createLlamaCppProvider()
    const publications: ModelsPublication[] = []

    await restored.provider.refreshModels?.(
      refreshContext({
        stored,
        allowNetwork: false,
        publish: (publication) => {
          publications.push(publication)
          publication.update?.()
          return Promise.resolve(true)
        },
      }),
    )

    expect(fetch).not.toHaveBeenCalled()
    expect(publications).toHaveLength(1)
    expect(publications[0]).not.toHaveProperty('persist')
    expect(restored.provider.getModels()).toEqual([
      expect.objectContaining({ id: 'cached-decoder', baseUrl: `${root}/prefix/v1`, contextWindow: 128_000 }),
    ])
    expect(
      restored.provider
        .getAllModels?.()
        .filter((model) => model.type === 'classifier')
        .map((model) => [model.id, model.api, model.baseUrl]),
    ).toEqual([
      ['cached-decision', 'typesafe-system-one', `${root}/prefix/v1`],
      ['cached-decoder', 'llama-cpp-classify', `${root}/prefix`],
    ])
  })

  it('validates context limits and preserves runtime, CLI, cache, training, and default precedence', async () => {
    const root = await listen((request, response) => {
      if (request.url !== '/models') {
        sendJson(response, {})
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`{"data":[
        {"id":"runtime","status":{"value":"loaded","args":["-c","400"]},"meta":{"n_ctx":300,"n_ctx_train":500}},
        {"id":"cli","status":{"value":"loaded","args":["--ctx-size","400"]},"meta":{"n_ctx":true,"n_ctx_train":500}},
        {"id":"cache","status":{"value":"loaded","args":["-c","0"]},"meta":{"n_ctx":"500","n_ctx_train":600}},
        {"id":"training","status":{"value":"loaded","args":["-c","unsafe"]},"meta":{"n_ctx":1.5,"n_ctx_train":700}},
        {"id":"default","status":{"value":"loaded","args":[]},"meta":{"n_ctx":1e309,"n_ctx_train":null}},
        {"id":"runtime-zero","status":{"value":"loaded"},"meta":{"n_ctx":0,"n_ctx_train":701}},
        {"id":"runtime-negative","status":{"value":"loaded"},"meta":{"n_ctx":-1,"n_ctx_train":702}},
        {"id":"runtime-unsafe","status":{"value":"loaded"},"meta":{"n_ctx":9007199254740992,"n_ctx_train":703}},
        {"id":"invalid-cache-fallback","status":{"value":"loaded"},"meta":{"n_ctx":0,"n_ctx_train":750}},
        {"id":"decision-training","status":{"value":"loaded"},"architecture":{"output_modalities":["decisions"]},"meta":{"n_ctx":false,"n_ctx_train":900}}
      ]}`)
    })
    const cached = await createLlamaCppProvider()
    cached.setCatalog(
      [
        { id: 'runtime', status: { value: 'loaded' } },
        { id: 'cli', status: { value: 'loaded' } },
        { id: 'cache', status: { value: 'loaded' } },
        { id: 'invalid-cache-fallback', status: { value: 'loaded' } },
      ],
      root,
    )
    const stored: ModelsStoreEntry = {
      models: (cached.provider.getAllModels?.() ?? []).map((model) =>
        model.id === 'cache' || model.id === 'runtime'
          ? { ...model, contextWindow: 800, ...(model.api === 'openai-completions' ? { maxTokens: 123 } : {}) }
          : model.id === 'invalid-cache-fallback'
            ? ({
                ...model,
                contextWindow: null,
                ...(model.api === 'openai-completions' ? { maxTokens: '14' } : {}),
              } as unknown as ModelsStoreEntry['models'][number])
            : model,
      ),
    }
    const controller = await createLlamaCppProvider()
    const publications: ModelsPublication[] = []
    await controller.provider.refreshModels?.(
      refreshContext({
        credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: root } },
        stored,
        allowNetwork: true,
        publish: (publication) => {
          publications.push(publication)
          publication.update?.()
          return Promise.resolve(true)
        },
      }),
    )

    const models = controller.provider.getModels()
    expect(models.map(({ id, contextWindow, maxTokens }) => [id, contextWindow, maxTokens])).toEqual([
      ['runtime', 300, 300],
      ['cli', 400, 400],
      ['cache', 800, 800],
      ['training', 700, 700],
      ['default', 128_000, 128_000],
      ['runtime-zero', 701, 701],
      ['runtime-negative', 702, 702],
      ['runtime-unsafe', 703, 703],
      ['invalid-cache-fallback', 750, 750],
    ])
    const classifiers = controller.provider.getAllModels?.().filter((model) => model.type === 'classifier') ?? []
    expect(classifiers.map(({ id, contextWindow }) => [id, contextWindow])).toEqual([
      ['runtime', 300],
      ['cli', 400],
      ['cache', 800],
      ['training', 700],
      ['default', 128_000],
      ['runtime-zero', 701],
      ['runtime-negative', 702],
      ['runtime-unsafe', 703],
      ['invalid-cache-fallback', 750],
      ['decision-training', 900],
    ])
    expect(publications.at(-1)?.persist?.models).toEqual(expect.arrayContaining([...models]))
    for (const model of [...models, ...classifiers]) {
      expect(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0).toBeTruthy()
    }
    for (const model of models) {
      expect(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0).toBeTruthy()
    }
  })

  it('normalizes malformed cached token limits before offline publication and fallback reuse', async () => {
    const root = await listen((_request, response) => {
      response.writeHead(500).end()
    })
    const source = await createLlamaCppProvider()
    source.setCatalog(
      [
        { id: 'valid-cache', status: { value: 'loaded' } },
        { id: 'bad-cache', status: { value: 'loaded' } },
        { id: 'bad-classifier', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions'] } },
      ],
      root,
    )
    const invalidLimits: unknown[] = [true, '42', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, -1, null]
    const [template] = source.provider.getModels()
    const stored: ModelsStoreEntry = {
      models: [
        ...(source.provider.getAllModels?.() ?? []).map((model): ModelsStoreEntry['models'][number] => {
          if (model.id === 'valid-cache') {
            return {
              ...model,
              contextWindow: 2048,
              ...(model.api === 'openai-completions' ? { maxTokens: 64 } : {}),
            } as unknown as ModelsStoreEntry['models'][number]
          }
          if (model.id === 'bad-cache' && model.api === 'openai-completions') {
            return { ...model, contextWindow: null, maxTokens: 1.5 } as unknown as ModelsStoreEntry['models'][number]
          }
          if (model.id === 'bad-classifier') {
            return { ...model, contextWindow: '8192' } as unknown as ModelsStoreEntry['models'][number]
          }
          return model
        }),
        ...invalidLimits.map(
          (limit, index) =>
            ({
              ...template,
              id: `invalid-${index}`,
              contextWindow: limit,
              maxTokens: limit,
            }) as unknown as ModelsStoreEntry['models'][number],
        ),
      ],
    }
    const controller = await createLlamaCppProvider()
    const publications: ModelsPublication[] = []
    await controller.provider.refreshModels?.(
      refreshContext({
        stored,
        allowNetwork: false,
        publish: (publication) => {
          publications.push(publication)
          publication.update?.()
          return Promise.resolve(true)
        },
      }),
    )

    expect(publications).toHaveLength(1)
    expect(publications[0]).not.toHaveProperty('persist')
    const restoredModels = controller.provider.getModels()
    expect(restoredModels.map(({ id }) => id)).toEqual([
      'valid-cache',
      'bad-cache',
      ...invalidLimits.map((_, index) => `invalid-${index}`),
    ])
    expect(restoredModels[0]).toMatchObject({ contextWindow: 2048, maxTokens: 64 })
    expect(
      restoredModels.slice(1).every((model) => model.contextWindow === 128_000 && model.maxTokens === 128_000),
    ).toBeTruthy()
    expect(
      controller.provider
        .getAllModels?.()
        .filter((model) => model.type === 'classifier')
        .map(({ id, contextWindow }) => [id, contextWindow]),
    ).toEqual([
      ['valid-cache', 2048],
      ['bad-cache', 128_000],
      ['bad-classifier', 128_000],
    ])
    for (const model of controller.provider.getModels()) {
      expect(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0).toBeTruthy()
    }
    for (const model of controller.provider.getAllModels?.().filter((entry) => entry.type === 'classifier') ?? []) {
      expect(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0).toBeTruthy()
    }
    for (const model of controller.provider.getModels()) {
      expect(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0).toBeTruthy()
    }
  })

  it('skips network refresh when offline, unconfigured, aborted, or publication is stale', async () => {
    const realFetch = globalThis.fetch
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const controller = await createLlamaCppProvider()
    const publish = vi.fn<RefreshModelsContext['publish']>(() => Promise.resolve(false))
    await controller.provider.refreshModels?.(refreshContext({ allowNetwork: false }))
    await controller.provider.refreshModels?.(refreshContext({ allowNetwork: true }))
    const abort = new AbortController()
    abort.abort()
    await controller.provider.refreshModels?.(
      refreshContext({
        credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: 'http://127.0.0.1:8080' } },
        allowNetwork: true,
        signal: abort.signal,
      }),
    )
    expect(fetch).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', realFetch)
    const root = await listen((_request, response) =>
      sendJson(response, { data: [{ id: 'late', status: { value: 'loaded' } }] }),
    )
    const stale = await createLlamaCppProvider()
    stale.setCatalog([{ id: 'previous', status: { value: 'loaded' } }], root)
    await stale.provider.refreshModels?.(
      refreshContext({
        credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: root } },
        allowNetwork: true,
        publish,
      }),
    )
    expect(publish).toHaveBeenCalledOnce()
    expect(stale.provider.getModels().map((model) => model.id)).toEqual(['previous'])
  })

  it('uses native System One for decision metadata and preserves answers, usage, failures, and aborts', async () => {
    const root = `http://127.0.0.1:8080/prefix`
    const controller = await createLlamaCppProvider()
    controller.setCatalog(
      [
        { id: 'arbitrary-id', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions'] } },
        { id: 'ordinary-decoder', status: { value: 'loaded' }, architecture: { output_modalities: ['text'] } },
      ],
      `${root}/v1`,
    )
    const decisionModel = controller.provider
      .getAllModels?.()
      .find((model) => model.type === 'classifier' && model.id === 'arbitrary-id')
    if (decisionModel?.type !== 'classifier') {
      throw new Error('missing decision classifier')
    }
    if (!controller.provider.classify) {
      throw new Error('missing classifier handler')
    }
    expect(decisionModel.api).toBe('typesafe-system-one')
    expect(decisionModel.baseUrl).toBe(`${root}/v1`)
    expect(decisionModel.input).toEqual(['text'])

    const requests: { url: string; authorization: string | null; payload: Record<string, unknown> }[] = []
    const context = {
      state: { message: 'Approve routine change' },
      questions: {
        kind: {
          type: 'choice' as const,
          instructions: 'Classify',
          criteria: { routine: 'Routine', urgent: 'Urgent' },
        },
        approved: { type: 'bool' as const, instructions: 'Approved?', criteria: { true: 'Yes', false: 'No' } },
      },
    }
    const result = await controller.provider.classify(decisionModel, context, {
      apiKey: 'secret',
      fetch: (input, init) => {
        requests.push({
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get('authorization'),
          payload: JSON.parse(requestBodyText(init?.body)) as Record<string, unknown>,
        })
        return Promise.resolve(
          new Response(
            JSON.stringify({
              answers: {
                kind: {
                  type: 'choice',
                  choice: 'routine',
                  probabilities: { routine: 0.9, urgent: 0.1 },
                  confidence: 0.8,
                },
                approved: { type: 'noul', noul: 0.9644 },
              },
              usage: { input_tokens: 42, output_tokens: 3 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      },
    })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request).toMatchObject({
      url: `${root}/v1/systemone`,
      authorization: 'Bearer secret',
      payload: {
        model: 'arbitrary-id',
        state: context.state,
        questions: { kind: { type: 'choice' }, approved: { type: 'noul' } },
      },
    })
    expect(result.stopReason).toBe('stop')
    expect(result.answers).toEqual({
      kind: { type: 'choice', choice: 'routine', probabilities: { routine: 0.9, urgent: 0.1 }, confidence: 0.8 },
      approved: { type: 'bool', probability: 0.9644 },
    })
    expect(result.usage).toMatchObject({ input: 42, output: 3, totalTokens: 45 })

    const failedRequests: string[] = []
    const failed = await controller.provider.classify(decisionModel, context, {
      apiKey: 'secret',
      maxRetries: 0,
      fetch: (input) => {
        failedRequests.push(requestUrl(input))
        return Promise.resolve(new Response('System One unavailable', { status: 500 }))
      },
    })
    expect(failed.stopReason).toBe('error')
    expect(failedRequests).toEqual([`${root}/v1/systemone`])

    let requestStarted = (): void => {
      throw new Error('request has not started')
    }
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const abort = new AbortController()
    const pending = controller.provider.classify(decisionModel, context, {
      apiKey: 'secret',
      signal: abort.signal,
      maxRetries: 0,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            throw new Error('missing System One request signal')
          }
          requestStarted()
          init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    })
    await started
    abort.abort()
    expect((await pending).stopReason).toBe('aborted')
  })

  it('keeps ordinary decoders on the native llama.cpp classifier API', async () => {
    const root = 'http://127.0.0.1:8080/prefix'
    const controller = await createLlamaCppProvider()
    controller.setCatalog([{ id: 'clef-without-metadata', status: { value: 'loaded' } }], `${root}/v1`)
    const catalogModel = controller.provider
      .getAllModels?.()
      .find((model) => model.type === 'classifier' && model.id === 'clef-without-metadata')
    if (catalogModel?.type !== 'classifier') {
      throw new Error('missing ordinary classifier')
    }
    if (!controller.provider.classify) {
      throw new Error('missing classifier handler')
    }
    expect(catalogModel.api).toBe('llama-cpp-classify')

    const requests: { url: string; authorization: string | null; payload: Record<string, unknown> }[] = []
    const context = {
      state: { message: 'The build failed.' },
      questions: {
        kind: {
          type: 'choice' as const,
          instructions: 'What failed?',
          criteria: { billing: 'Billing', ci: 'CI' },
        },
      },
    }
    const result = await controller.provider.classify({ ...catalogModel, baseUrl: `${root}/v1` }, context, {
      apiKey: 'secret',
      fetch: (input, init) => {
        const url = requestUrl(input)
        const payload = JSON.parse(requestBodyText(init?.body)) as Record<string, unknown>
        requests.push({ url, authorization: new Headers(init?.headers).get('authorization'), payload })
        if (url.endsWith('/tokenize')) {
          const text = String(payload.content)
          return Promise.resolve(
            new Response(JSON.stringify({ tokens: Array.from(text, (character) => character.codePointAt(0)) })),
          )
        }
        if (url.endsWith('/apply-template')) {
          return Promise.resolve(new Response(JSON.stringify({ prompt: '<|im_start|>assistant\\n' })))
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              completion_probabilities: [
                {
                  top_logprobs: [
                    { id: 65, token: 'A', logprob: -0.1 },
                    { id: 66, token: 'B', logprob: -2.4 },
                  ],
                },
              ],
            }),
          ),
        )
      },
    })

    expect(new Set(requests.map((request) => new URL(request.url).pathname))).toEqual(
      new Set(['/prefix/tokenize', '/prefix/apply-template', '/prefix/completion']),
    )
    expect(requests.every((request) => request.authorization === 'Bearer secret')).toBeTruthy()
    expect(requests.find((request) => request.url.endsWith('/completion'))?.payload).toMatchObject({
      model: 'clef-without-metadata',
      n_predict: 1,
      post_sampling_probs: false,
    })
    expect(result.stopReason).toBe('stop')
    expect(result.answers.kind).toMatchObject({ type: 'choice', choice: 'billing' })

    const aborted = new AbortController()
    aborted.abort()
    const unusedFetch = vi.fn<typeof globalThis.fetch>()
    const abortedResult = await controller.provider.classify(catalogModel, context, {
      apiKey: 'secret',
      signal: aborted.signal,
      fetch: unusedFetch,
    })
    expect(abortedResult.stopReason).toBe('aborted')
    expect(unusedFetch).toHaveBeenCalledOnce()
    expect(unusedFetch.mock.calls[0]?.[1]?.signal?.aborted).toBeTruthy()
  })

  it('streams ordinary chat through the native OpenAI-compatible provider API', async () => {
    const root = 'http://127.0.0.1:8080/prefix'
    const controller = await createLlamaCppProvider()
    controller.setCatalog([{ id: 'chat-model', status: { value: 'loaded' } }], `${root}/v1`)
    const [model] = controller.provider.getModels()
    const context = normalizeContext({
      messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
    })
    const chunks = [
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ]
    const eventFrames = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
    const payloads: unknown[] = []
    const responses: number[] = []
    const providerEvents: unknown[] = []
    const events = []
    for await (const event of controller.provider.streamSimple(model, context, {
      apiKey: 'secret',
      fetch: (input, init) => {
        expect(requestUrl(input)).toBe(`${root}/v1/chat/completions`)
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
        return Promise.resolve(new Response(eventFrames, { headers: { 'content-type': 'text/event-stream' } }))
      },
      onPayload: (payload) => {
        payloads.push(payload)
        return payload
      },
      onResponse: (response) => {
        responses.push(response.status)
      },
      onProviderStreamEvent: (event) => {
        providerEvents.push(event)
      },
    })) {
      events.push(event)
    }

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ model: 'chat-model', messages: [{ role: 'user', content: 'Hello' }] })
    expect(responses).toEqual([200])
    expect(providerEvents.length).toBeGreaterThan(0)
    expect(events[0]?.type).toBe('start')
    const done = events.find((event) => event.type === 'done')
    expect(done?.message.content).toContainEqual({ type: 'text', text: 'Hello' })
    expect(done?.message.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 })

    const apiEvents = []
    for await (const event of controller.provider.stream(model, context, {
      apiKey: 'secret',
      fetch: (input) => {
        expect(requestUrl(input)).toBe(`${root}/v1/chat/completions`)
        return Promise.resolve(new Response(eventFrames, { headers: { 'content-type': 'text/event-stream' } }))
      },
    })) {
      apiEvents.push(event)
    }
    const apiDone = apiEvents.find((event) => event.type === 'done')
    expect(apiDone?.message.content).toContainEqual({ type: 'text', text: 'Hello' })
  })

  it('aborts native chat streaming through the caller signal', async () => {
    const controller = await createLlamaCppProvider()
    controller.setCatalog([{ id: 'chat-model', status: { value: 'loaded' } }], 'http://127.0.0.1:8080')
    const [model] = controller.provider.getModels()
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] })
    let startRequest!: () => void
    const started = new Promise<void>((resolve) => {
      startRequest = resolve
    })
    const abort = new AbortController()
    const pending = (async () => {
      const events = []
      for await (const event of controller.provider.streamSimple(model, context, {
        apiKey: 'secret',
        signal: abort.signal,
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (!init?.signal) {
              throw new Error('missing chat request signal')
            }
            startRequest()
            init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          }),
      })) {
        events.push(event)
      }
      return events
    })()
    await started
    abort.abort()
    const events = await pending
    const terminal = events.find((event) => event.type === 'done' || event.type === 'error')
    expect(terminal?.type).toBe('error')
    expect(terminal).toMatchObject({ type: 'error', reason: 'aborted', error: { stopReason: 'aborted' } })
  })

  it('does not publish a catalog when an in-flight props request returns after cancellation', async () => {
    const controller = await createLlamaCppProvider()
    const abort = new AbortController()
    let releaseProps!: (response: Response) => void
    let startProps!: () => void
    const propsStarted = new Promise<void>((resolve) => {
      startProps = resolve
    })
    const propsResponse = new Promise<Response>((resolve) => {
      releaseProps = resolve
    })
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'late', status: { value: 'loaded' } }] })))
      }
      startProps()
      return propsResponse
    })
    const publish = vi.fn<RefreshModelsContext['publish']>(() => Promise.resolve(true))
    const refresh = controller.provider.refreshModels?.(
      refreshContext({
        credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: 'http://127.0.0.1:8080/prefix' } },
        allowNetwork: true,
        signal: abort.signal,
        publish,
      }),
    )
    await propsStarted
    abort.abort()
    releaseProps(new Response(JSON.stringify({ chat_template: 'template' })))
    await refresh

    expect(publish).not.toHaveBeenCalled()
    expect(controller.provider.getModels()).toEqual([])
  })

  it('does not import Pi AI compatibility modules or access the network on module import', async () => {
    vi.resetModules()
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    vi.doMock('@earendil-works/pi-ai', () => {
      throw new Error('the optional provider must not import Pi AI at module load')
    })
    vi.doMock('@earendil-works/pi-ai/compat', () => {
      throw new Error('the optional provider must not import Pi’s global compatibility registry')
    })
    vi.doMock('@earendil-works/pi-coding-agent', () => {
      throw new Error('the optional provider must not resolve Pi packages at module load')
    })

    try {
      await import('./llama-cpp-provider.ts')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('@earendil-works/pi-ai')
      vi.doUnmock('@earendil-works/pi-ai/compat')
      vi.doUnmock('@earendil-works/pi-coding-agent')
      vi.resetModules()
    }
  })

  it('rejects non-array status args before context extraction without hanging or replacing the catalog', async () => {
    const packageDir = fileURLToPath(new URL('..', import.meta.url))
    const workspace = mkdtempSync(join(packageDir, '.llama-cpp-fixture-'))
    temporaryDirectories.push(workspace)
    const fixtureDist = join(workspace, 'fixture-dist')
    const loadedConfig = await loadConfig(fileURLToPath(new URL('../rolldown.config.ts', import.meta.url)))
    if (typeof loadedConfig === 'function' || Array.isArray(loadedConfig)) {
      throw new Error('Expected one published Rolldown config')
    }
    const { input, output } = loadedConfig
    if (!input || typeof input !== 'object' || Array.isArray(input) || !output || Array.isArray(output)) {
      throw new Error('Expected one input map and one output in the published Rolldown config')
    }
    const fixture = await build({
      ...loadedConfig,
      input: Object.fromEntries(
        Object.entries(input).map(([name, entry]) => {
          if (typeof entry !== 'string') {
            throw new Error(`Expected a single input file for ${name}`)
          }
          return [name, resolve(packageDir, entry)]
        }),
      ),
      output: { ...output, dir: fixtureDist },
      write: true,
    })
    if (!fixture.output.some((item) => item.type === 'chunk' && item.fileName === 'llama-cpp-provider.js')) {
      throw new Error('Published Rolldown config did not emit the optional provider entry')
    }
    const entryUrl = pathToFileURL(join(fixtureDist, 'llama-cpp-provider.js')).href
    const childScript = `
      import { createLlamaCppProvider } from ${JSON.stringify(entryUrl)};
      const controller = await createLlamaCppProvider();
      controller.setCatalog([{ id: 'previous', status: { value: 'loaded' } }], 'http://127.0.0.1:8080');
      const payloads = [
        '{"data":[{"id":"malformed","status":{"value":"sleeping","args":{"length":1e309}}}]}',
        '{"data":[{"id":"malformed","status":{"value":"sleeping","args":null}}]}',
        '{"data":[{"id":"malformed","status":{"value":"sleeping","args":"-c 20"}}]}',
        '{"data":[{"id":"malformed","status":{"value":"sleeping","args":["-c",20]}}]}',
      ];
      let payloadIndex = 0;
      globalThis.fetch = async () => new Response(payloads[payloadIndex++], { headers: { 'content-type': 'application/json' } });
      const outcomes = [];
      for (let index = 0; index < payloads.length; index++) {
        try {
          await controller.provider.refreshModels({
            credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: 'http://127.0.0.1:8080' } },
            allowNetwork: true,
            signal: new AbortController().signal,
            publish: (publication) => { publication.update?.(); return Promise.resolve(true); },
          });
          outcomes.push({ kind: 'resolved' });
        } catch (error) {
          outcomes.push({ kind: 'rejected', message: String(error) });
        }
      }
      console.log(JSON.stringify({ outcomes, ids: controller.provider.getModels().map((model) => model.id) }));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 3000,
    })
    const { error, status, stdout } = child
    expect(error).toBeUndefined()
    expect(status).toBe(0)
    const childResult = JSON.parse(stdout.trim()) as {
      outcomes: { kind: string; message?: string }[]
      ids: string[]
    }
    expect(childResult.outcomes.map(({ kind, message }) => [kind, message?.includes('invalid')])).toEqual([
      ['rejected', true],
      ['rejected', true],
      ['rejected', true],
      ['rejected', true],
    ])
    expect(childResult.ids).toEqual(['previous'])

    const controller = await createLlamaCppProvider()
    controller.setCatalog(
      [{ id: 'boundary', status: { value: 'sleeping', args: { length: Infinity } } as never }],
      'http://127.0.0.1:8080',
    )
    expect(controller.provider.getModels()).toEqual([
      expect.objectContaining({ id: 'boundary', contextWindow: 128_000, maxTokens: 128_000 }),
    ])
  })

  it('rejects malformed modality metadata without replacing the last published catalog', async () => {
    let data: unknown[] = [
      { id: 'invalid', status: { value: 'loaded' }, architecture: { output_modalities: ['decisions', 1] } },
    ]
    const root = await listen((_request, response) => sendJson(response, { data }))
    const controller = await createLlamaCppProvider()
    controller.setCatalog([{ id: 'previous', status: { value: 'loaded' } }], root)

    await expect(
      controller.provider.refreshModels?.(
        refreshContext({
          credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: root } },
          allowNetwork: true,
        }),
      ),
    ).rejects.toThrow('invalid architecture metadata')
    expect(controller.provider.getModels().map((model) => model.id)).toEqual(['previous'])

    data = [{ id: 'no-metadata', status: { value: 'loaded' } }]
    await controller.provider.refreshModels?.(
      refreshContext({
        credential: { type: 'api_key', key: 'local', env: { LLAMA_BASE_URL: root } },
        allowNetwork: true,
      }),
    )
    expect(controller.provider.getModels().map((model) => model.id)).toEqual(['no-metadata'])
    expect(controller.provider.getAllModels?.().find((model) => model.type === 'classifier')?.api).toBe(
      'llama-cpp-classify',
    )
  })
})
