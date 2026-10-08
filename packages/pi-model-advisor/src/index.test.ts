import type { ClassifierContext, ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai'
import type { ExtensionCommandContext, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import type { ConfigurationResult } from './config.ts'
import { registerModelAdvisorExtension } from './index.ts'
import { chatModel, validClassifierResult } from './test-fixtures.ts'

function registerToolStub(): ExtensionAPI['registerTool'] {
  return () => undefined
}

function extensionApi(
  registerCommand: ExtensionAPI['registerCommand'],
  registerTool = registerToolStub(),
): Pick<ExtensionAPI, 'registerCommand' | 'registerTool' | 'on' | 'appendEntry'> {
  return { registerCommand, registerTool, on: () => () => undefined, appendEntry: () => undefined }
}

function validConfiguration(): ConfigurationResult {
  return {
    status: 'valid' as const,
    configuration: {
      classifier: { provider: 'openrouter', model: 'typesafe/jev-1.13' },
      models: {
        light: [
          {
            provider: 'openai',
            model: 'gpt-luna',
            priority: 0,
            thinking: { minimum: 'max' as const, maximum: 'max' as const },
          },
        ],
      },
      tasks: {},
      thinking: { minimum: 'off' as const, maximum: 'max' as const },
      policy: {
        capabilityPercentile: 75,
        consequenceThresholds: { advanced: 0.7, frontier: 0.9 },
        overallDeadlineMs: 60_000,
      },
      logging: { includeTask: false },
    },
  }
}

function commandContext(classifiers = [{ provider: 'openrouter', id: 'typesafe/jev-1.13' }]) {
  const classify = vi.fn<() => void>()
  const notify = vi.fn<ExtensionCommandContext['ui']['notify']>()
  const context = {
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [
        {
          provider: 'openai',
          id: 'gpt-luna',
          api: 'openai-completions',
          name: 'GPT Luna',
          reasoning: true,
          thinkingLevelMap: { max: 'max' },
          contextWindow: 32_000,
          maxTokens: 4_000,
          input: ['text'],
        },
        {
          provider: 'openai',
          id: 'gpt-unclassified',
          api: 'openai-completions',
          name: 'GPT unclassified',
          reasoning: false,
          contextWindow: 32_000,
          maxTokens: 4_000,
          input: ['text'],
        },
      ],
      getAvailableOfType: () => Promise.resolve(classifiers),
      classify,
    },
    ui: { notify },
  }
  return { context: context as unknown as ExtensionCommandContext, classify, notify }
}

describe('registerModelAdvisorExtension', () => {
  it('loads one configuration snapshot and reports classifier and chat eligibility without inference', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const registerTool = registerToolStub()
    const loadConfiguration = vi.fn<() => Promise<ConfigurationResult>>(() => Promise.resolve(validConfiguration()))
    await registerModelAdvisorExtension(extensionApi(registerCommand, registerTool), {
      loadConfiguration,
    })
    const [[, command]] = registerCommand.mock.calls
    const { context, classify, notify } = commandContext()

    await command.handler('', context)
    await command.handler('doctor', context)
    await command.handler('models', context)
    await command.handler('config', context)

    expect(registerCommand).toHaveBeenCalledExactlyOnceWith('model-advisor', expect.any(Object))
    expect(loadConfiguration).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Classifier: available'), 'info')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('1 eligible'), 'info')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('gpt-unclassified'), 'info')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No classifier inference was made.'), 'info')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Active configuration snapshot:'), 'info')
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Configuration edits apply only after extension initialization or Pi /reload.'),
      'info',
    )
    expect(classify).not.toHaveBeenCalled()
  })

  it('reports unavailable classifier diagnostics and retains the configuration snapshot', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const registerTool = registerToolStub()
    await registerModelAdvisorExtension(extensionApi(registerCommand, registerTool), {
      loadConfiguration: () => Promise.resolve(validConfiguration()),
    })
    const [[, command]] = registerCommand.mock.calls
    const { context, notify, classify } = commandContext([])

    await command.handler('config', context)

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Configuration: configuration_error'), 'error')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Classifier: unavailable'), 'error')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('classifier_unavailable'), 'error')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Active configuration snapshot:'), 'error')
    expect(classify).not.toHaveBeenCalled()
  })

  it('previews an explicit task without reading parent transcript state', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const registerTool = registerToolStub()
    await registerModelAdvisorExtension(extensionApi(registerCommand, registerTool), {
      loadConfiguration: () => Promise.resolve(validConfiguration()),
    })
    const [[, command]] = registerCommand.mock.calls
    const classifier = {
      type: 'classifier',
      provider: 'openrouter',
      id: 'typesafe/jev-1.13',
      api: 'typesafe-system-one',
      name: 'offline test classifier',
      baseUrl: 'https://example.invalid',
      input: ['text'],
    } as ClassifierModel<string>
    const response: ClassifierResult = {
      ...validClassifierResult(),
      provider: classifier.provider,
      model: classifier.id,
    }
    const classify = vi.fn<(model: ClassifierModel<string>, context: ClassifierContext) => Promise<ClassifierResult>>(
      () => Promise.resolve(response),
    )
    const notify = vi.fn<ExtensionCommandContext['ui']['notify']>()
    const context = {
      scopedModels: [],
      signal: undefined,
      ui: { notify },
      modelRegistry: {
        getAvailable: () => [chatModel()],
        getAvailableOfType: () => Promise.resolve([classifier]),
        getModelOfType: () => classifier,
        classify,
      },
    } as unknown as ExtensionCommandContext

    await command.handler('recommend Implement this explicit task.', context)

    expect(classify).toHaveBeenCalledTimes(1)
    const [call] = classify.mock.calls
    const [, classifierContext] = call
    expect(classifierContext.state).toEqual({ task: 'Implement this explicit task.' })
    expect(Object.keys(classifierContext.questions)).toEqual([
      'required_capability',
      'reasoning_effort',
      'context_demand',
      'high_consequence',
    ])
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('"status": "recommended"'), 'info')
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Configuration edits apply only after extension initialization or Pi /reload.'),
      'info',
    )
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Privacy: explicit task state is sent to the configured Pi classifier'),
      'info',
    )
  })

  it('uses a fresh configuration after Pi reconstructs the extension', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const registerTool = registerToolStub()
    const loadConfiguration = vi
      .fn<() => Promise<ConfigurationResult>>()
      .mockResolvedValueOnce(validConfiguration())
      .mockResolvedValueOnce({
        status: 'configuration_error' as const,
        issues: [{ path: '', code: 'invalid_json' as const, message: 'Configuration file contains invalid JSON.' }],
      })
    const api = extensionApi(registerCommand, registerTool)

    await registerModelAdvisorExtension(api, { loadConfiguration })
    await registerModelAdvisorExtension(api, { loadConfiguration })
    const [, [, command]] = registerCommand.mock.calls
    const { context, notify } = commandContext()
    await command.handler('doctor', context)

    expect(loadConfiguration).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Configuration: configuration_error'), 'error')
  })
})
