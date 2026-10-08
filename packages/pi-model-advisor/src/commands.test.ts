import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { registerModelAdvisorExtension, type ModelAdvisorExtensionOptions } from './index.ts'
import { chatModel, validClassifierResult, validRecommendationConfiguration } from './test-fixtures.ts'
import type { RecommendationResult } from './types.ts'

function extensionApi() {
  const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
  return {
    registerCommand,
    registerTool: () => undefined,
    on: () => () => undefined,
    appendEntry: () => undefined,
  }
}

function commandContext(availableModels = [chatModel(), chatModel('openai-codex', 'gpt-luna')], signal?: AbortSignal) {
  const notify = vi.fn<ExtensionCommandContext['ui']['notify']>()
  const classify = vi.fn<ExtensionCommandContext['modelRegistry']['classify']>(() =>
    Promise.resolve(validClassifierResult()),
  )
  const context = {
    scopedModels: [],
    signal,
    ui: { notify },
    modelRegistry: {
      getAvailable: () => availableModels,
      getAvailableOfType: () => Promise.resolve([{ provider: 'llama.cpp', id: 'offline-classifier' }]),
      getModelOfType: () => ({ provider: 'llama.cpp', id: 'offline-classifier' }),
      classify,
    },
  } as unknown as ExtensionCommandContext
  return { context, notify, classify }
}

async function register(options: ModelAdvisorExtensionOptions = {}) {
  const api = extensionApi()
  await registerModelAdvisorExtension(api, {
    loadConfiguration: () => Promise.resolve(validRecommendationConfiguration()),
    ...options,
  })
  const [[, command]] = api.registerCommand.mock.calls
  return { command }
}

describe('model advisor commands', () => {
  it('shows the same /reload-only boundary on status, models, config, and doctor without inference', async () => {
    const { command } = await register()
    const { context, notify, classify } = commandContext()

    await command.handler('', context)
    await command.handler('models', context)
    await command.handler('config', context)
    await command.handler('doctor', context)

    const messages = notify.mock.calls.map(([message]) => message)
    expect(messages).toHaveLength(4)
    expect(
      messages.every((message) =>
        message.includes('Configuration edits apply only after extension initialization or Pi /reload.'),
      ),
    ).toBeTruthy()
    expect(messages.some((message) => message.includes('eligible'))).toBeTruthy()
    expect(classify).not.toHaveBeenCalled()
  })

  it('reports invalid model token limits in doctor diagnostics without inference', async () => {
    const { command } = await register()
    const invalid = { ...chatModel(), contextWindow: 0 } as Model<Api>
    const { context, notify, classify } = commandContext([invalid])

    await command.handler('doctor', context)

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Invalid model limits: openai/gpt-luna (invalid_context_window).'),
      'info',
    )
    expect(classify).not.toHaveBeenCalled()
  })

  it('accepts one native boolean answer for the connectivity probe without an eligible worker', async () => {
    const { command } = await register()
    const { context, notify, classify } = commandContext([])
    classify.mockResolvedValue({
      ...validClassifierResult(),
      answers: { connectivity: { type: 'bool', probability: 1 } },
    })

    await command.handler('doctor --connectivity', context)

    expect(classify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Connectivity probe: classifier responded.'), 'info')
  })

  it('rejects invalid native connectivity answers separately from lifecycle outcomes', async () => {
    const { command } = await register()
    const { context, notify, classify } = commandContext([])
    classify.mockResolvedValue({
      ...validClassifierResult(),
      answers: { connectivity: { type: 'bool', probability: 2 } },
    })

    await command.handler('doctor --connectivity', context)

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Connectivity probe: classifier_failed (invalid_answer)'),
      'error',
    )
  })

  it('enforces the configured deadline for an unresolved native connectivity probe', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status === 'valid') {
      configuration.configuration.policy.overallDeadlineMs = 10
    }
    const { command } = await register({ loadConfiguration: () => Promise.resolve(configuration) })
    const { context, notify, classify } = commandContext([])
    classify.mockImplementation(() => new Promise(() => {}))

    vi.useFakeTimers()
    let timerCount = -1
    try {
      const probe = command.handler('doctor --connectivity', context)
      await vi.advanceTimersByTimeAsync(10)
      await probe
      timerCount = vi.getTimerCount()
    } finally {
      vi.useRealTimers()
    }

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Connectivity probe: classifier_failed (deadline)'),
      'error',
    )
    expect(timerCount).toBe(0)
  })

  it('propagates caller cancellation to a native connectivity probe and clears its timer', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status === 'valid') {
      configuration.configuration.policy.overallDeadlineMs = 100
    }
    const { command } = await register({ loadConfiguration: () => Promise.resolve(configuration) })
    const caller = new AbortController()
    const { context, notify, classify } = commandContext([], caller.signal)
    let nativeSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    classify.mockImplementation(
      (_classifier, _classifierContext, options) =>
        new Promise(() => {
          nativeSignal = options?.signal
          markStarted()
        }),
    )

    vi.useFakeTimers()
    let timerCount = -1
    try {
      const probe = command.handler('doctor --connectivity', context)
      await started
      expect(vi.getTimerCount()).toBe(1)
      caller.abort()
      await probe
      timerCount = vi.getTimerCount()
    } finally {
      vi.useRealTimers()
    }

    expect(nativeSignal?.aborted).toBeTruthy()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Connectivity probe: aborted.'), 'error')
    expect(timerCount).toBe(0)
  })

  it('honors long valid deadlines for native connectivity probes without timer overflow', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status === 'valid') {
      configuration.configuration.policy.overallDeadlineMs = 2_147_483_648
    }
    const { command } = await register({ loadConfiguration: () => Promise.resolve(configuration) })
    const { context, notify, classify } = commandContext([])
    classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...validClassifierResult(),
                answers: { connectivity: { type: 'bool', probability: 1 } },
              }),
            5,
          )
        }),
    )

    vi.useFakeTimers()
    let timerCount = -1
    try {
      const probe = command.handler('doctor --connectivity', context)
      await vi.advanceTimersByTimeAsync(5)
      await probe
      timerCount = vi.getTimerCount()
    } finally {
      vi.useRealTimers()
    }

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Connectivity probe: classifier responded.'), 'info')
    expect(timerCount).toBe(0)
  })

  it('runs a classifier connectivity probe only when doctor --connectivity is explicit', async () => {
    const result: RecommendationResult = {
      status: 'classifier_failed',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      category: 'transport',
      message: 'secret provider response must not be shown',
    }
    const recommend: NonNullable<ModelAdvisorExtensionOptions['recommend']> = vi.fn<
      NonNullable<ModelAdvisorExtensionOptions['recommend']>
    >(() => Promise.resolve(result))
    const { command } = await register({ recommend })
    const { context, notify, classify } = commandContext([])
    classify.mockResolvedValue({
      ...validClassifierResult(),
      stopReason: 'error',
      errorMessage: 'secret provider response must not be shown',
    })

    await command.handler('doctor', context)
    expect(recommend).not.toHaveBeenCalled()

    await command.handler('doctor --connectivity', context)

    expect(classify).toHaveBeenCalledTimes(1)
    const [[classifier, classifierContext, options]] = classify.mock.calls
    expect(classifier).toMatchObject({ provider: 'llama.cpp', id: 'offline-classifier' })
    expect(classifierContext.state).toEqual({ probe: 'model-advisor-connectivity' })
    expect(Object.keys(classifierContext.questions)).toEqual(['connectivity'])
    expect(classifierContext.questions.connectivity.type).toBe('bool')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(recommend).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Connectivity probe: classifier_failed (transport)'),
      'error',
    )
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('secret provider response'), expect.anything())
  })
})
