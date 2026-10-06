import type { ExtensionCommandContext, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import type { ConfigurationResult } from './config.ts'
import { registerModelAdvisorExtension } from './index.ts'

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

function commandContext() {
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
      getAvailableOfType: () => Promise.resolve([{ provider: 'openrouter', id: 'typesafe/jev-1.13' }]),
      classify,
    },
    ui: { notify },
  }
  return { context: context as unknown as ExtensionCommandContext, classify, notify }
}

describe('registerModelAdvisorExtension', () => {
  it('loads one configuration snapshot and reports classifier and chat eligibility without inference', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const loadConfiguration = vi.fn<() => Promise<ConfigurationResult>>(() => Promise.resolve(validConfiguration()))
    await registerModelAdvisorExtension(
      { registerCommand },
      {
        loadConfiguration,
      },
    )
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
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Pi /reload only.'), 'info')
    expect(classify).not.toHaveBeenCalled()
  })

  it('uses a fresh configuration after Pi reconstructs the extension', async () => {
    const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
    const loadConfiguration = vi
      .fn<() => Promise<ConfigurationResult>>()
      .mockResolvedValueOnce(validConfiguration())
      .mockResolvedValueOnce({
        status: 'configuration_error' as const,
        issues: [{ path: '', code: 'invalid_json' as const, message: 'Configuration file contains invalid JSON.' }],
      })
    const api: Pick<ExtensionAPI, 'registerCommand'> = { registerCommand }

    await registerModelAdvisorExtension(api, { loadConfiguration })
    await registerModelAdvisorExtension(api, { loadConfiguration })
    const [, [, command]] = registerCommand.mock.calls
    const { context, notify } = commandContext()
    await command.handler('doctor', context)

    expect(loadConfiguration).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Configuration: configuration_error'), 'error')
  })
})
