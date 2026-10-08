import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { InMemoryCredentialStore, InMemoryModelsStore, type ClassifierContext } from '@earendil-works/pi-ai'
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
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-model-advisor-native-llama-'))
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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Pi native llama.cpp provider', () => {
  it('discovers chat and decision models, classifies with auth and usage, streams chat, aborts, and survives reload', async () => {
    vi.stubEnv('LLAMA_BASE_URL', '')
    vi.stubEnv('LLAMA_API_KEY', '')

    const catalog = [
      {
        id: 'chat-model',
        status: { value: 'loaded' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        meta: { n_ctx: 8192 },
      },
      {
        id: 'decision-model',
        status: { value: 'loaded' },
        architecture: { output_modalities: ['decisions'] },
        meta: { n_ctx: 4096 },
      },
    ]
    const requests: {
      method: string
      path: string
      authorization: string | undefined
      payload?: Record<string, unknown>
    }[] = []
    let markAbortStarted!: () => void
    let markAbortObserved!: () => void
    const abortStarted = new Promise<void>((resolve) => {
      markAbortStarted = resolve
    })
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve
    })
    const root = await listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const method = request.method ?? 'GET'
      const path = `${url.pathname}${url.search}`
      if (method === 'GET') {
        requests.push({ method, path, authorization: request.headers.authorization })
        if (url.pathname === '/prefix/models') {
          sendJson(response, { data: catalog })
        } else if (url.pathname === '/prefix/props') {
          sendJson(response, { chat_template: '' })
        } else {
          response.writeHead(404).end()
        }
        return
      }

      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        requests.push({ method, path, authorization: request.headers.authorization, payload })
        if (url.pathname === '/prefix/v1/systemone') {
          const state = payload.state as Record<string, unknown>
          if (state.abort === true) {
            markAbortStarted()
            response.on('close', markAbortObserved)
            return
          }
          sendJson(response, {
            answers: {
              choice: {
                type: 'choice',
                choice: 'routine',
                probabilities: { routine: 0.9, urgent: 0.1 },
                confidence: 0.8,
              },
              approved: { type: 'noul', noul: 0.9644 },
            },
            usage: { input_tokens: 42, output_tokens: 3 },
          })
          return
        }
        if (url.pathname === '/prefix/v1/chat/completions') {
          const chunks = [
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
          const frames = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(frames)
          return
        }
        response.writeHead(404).end()
      })
    })
    const serverUrl = `${root}/prefix`
    const workspace = temporaryDirectory()
    const cwd = join(workspace, 'project')
    const agentDir = join(workspace, 'agent')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(agentDir, { recursive: true })

    const credentials = new InMemoryCredentialStore()
    await credentials.modify('llama.cpp', () =>
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
    const builtinPath = pathToFileURL(join(getPackageDir(), 'dist/extensions/llama/index.js')).href
    const builtinModule = (await import(builtinPath)) as { default: ExtensionFactory }
    const builtinExtension: InlineExtension = {
      name: 'llama.cpp',
      builtin: true,
      factory: builtinModule.default,
    }
    const settingsManager = SettingsManager.create(cwd, agentDir)
    settingsManager.setExtensionPaths(['builtin:llama.cpp'])
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [builtinExtension],
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

    try {
      await session.bindExtensions({ shutdownHandler: () => undefined })
      expect(resourceLoader.getExtensions().errors).toEqual([])
      expect(resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(
        'builtin:llama.cpp',
      )

      const nativeProvider = modelRuntime.getRegisteredNativeProvider('llama.cpp')
      expect(nativeProvider).toBeDefined()
      expect(nativeProvider?.name).toBe('llama.cpp')
      expect(modelRuntime.getProvider('llama.cpp')).toBe(nativeProvider)
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === 'llama.cpp')).toEqual(['llama.cpp'])

      const refresh = await modelRuntime.refresh({ providers: ['llama.cpp'], allowNetwork: true, force: true })
      expect(refresh.aborted).toBeFalsy()
      expect(refresh.errors.get('llama.cpp')).toBeUndefined()

      const availableChat = await modelRuntime.getAvailable()
      const availableClassifiers = await modelRuntime.getAvailableOfType('classifier', 'llama.cpp')
      expect(availableChat.map(({ id }) => id)).toEqual(['chat-model'])
      expect(availableClassifiers.map(({ id, api }) => [id, api])).toEqual([
        ['chat-model', 'llama-cpp-classify'],
        ['decision-model', 'typesafe-system-one'],
      ])

      const decisionModel = modelRuntime.getModelOfType('classifier', 'llama.cpp', 'decision-model')
      const chatModel = modelRuntime.getModel('llama.cpp', 'chat-model')
      if (!decisionModel || !chatModel) {
        throw new Error('Pi native llama.cpp discovery did not expose the fixture models')
      }
      const classifierContext: ClassifierContext = {
        state: { message: 'Approve routine change' },
        questions: {
          choice: {
            type: 'choice',
            instructions: 'Classify the change.',
            criteria: { routine: 'Routine', urgent: 'Urgent' },
          },
          approved: { type: 'bool', instructions: 'Is the change approved?', criteria: { true: 'Yes', false: 'No' } },
        },
      }
      const classified = await modelRuntime.classify(decisionModel, classifierContext)
      expect(classified.stopReason).toBe('stop')
      expect(classified.answers).toEqual({
        choice: {
          type: 'choice',
          choice: 'routine',
          probabilities: { routine: 0.9, urgent: 0.1 },
          confidence: 0.8,
        },
        approved: { type: 'bool', probability: 0.9644 },
      })
      expect(classified.usage).toMatchObject({ input: 42, output: 3, totalTokens: 45 })

      const streamEvents = []
      for await (const event of modelRuntime.streamSimple(
        chatModel,
        normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] }),
      )) {
        streamEvents.push(event)
      }
      const chatDone = streamEvents.find((event) => event.type === 'done')
      expect(chatDone?.message.content).toContainEqual({ type: 'text', text: 'Hello' })
      expect(chatDone?.message.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 })

      const abortController = new AbortController()
      const abortContext: ClassifierContext = {
        state: { abort: true },
        questions: {
          cancelled: {
            type: 'bool',
            instructions: 'Will this request be cancelled?',
            criteria: { true: 'Yes', false: 'No' },
          },
        },
      }
      const pendingAbort = modelRuntime.classify(decisionModel, abortContext, { signal: abortController.signal })
      await abortStarted
      abortController.abort()
      expect((await pendingAbort).stopReason).toBe('aborted')
      await abortObserved

      const dispatches = requests.filter(({ method }) => method === 'POST')
      expect(dispatches.map(({ path }) => path)).toEqual(
        expect.arrayContaining(['/prefix/v1/systemone', '/prefix/v1/chat/completions']),
      )
      expect(requests.every(({ authorization }) => authorization === 'Bearer runtime-secret')).toBeTruthy()
      expect(dispatches.find(({ path }) => path === '/prefix/v1/systemone')?.payload).toMatchObject({
        model: 'decision-model',
        state: { message: 'Approve routine change' },
        questions: { choice: { type: 'choice' }, approved: { type: 'noul' } },
      })
      expect(dispatches.find(({ path }) => path === '/prefix/v1/chat/completions')?.payload).toMatchObject({
        model: 'chat-model',
      })

      await session.reload()
      const reloadedProvider = modelRuntime.getRegisteredNativeProvider('llama.cpp')
      expect(reloadedProvider).toBeDefined()
      expect(reloadedProvider).not.toBe(nativeProvider)
      expect(modelRuntime.getProvider('llama.cpp')).toBe(reloadedProvider)
      expect(reloadedProvider?.name).toBe('llama.cpp')
      expect(modelRuntime.getRegisteredProviderIds().filter((id) => id === 'llama.cpp')).toEqual(['llama.cpp'])
    } finally {
      session.dispose()
    }
  })
})
