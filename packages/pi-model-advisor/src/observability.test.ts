import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { recommendSubagentModel } from './core.ts'
import { registerModelAdvisorExtension, type ModelAdvisorExtensionOptions } from './index.ts'
import {
  chatModel,
  validClassifierResult,
  validRecommendationConfiguration,
  validRecommendationRequest,
} from './test-fixtures.ts'
import type { RecommendationResult } from './types.ts'

interface RegisteredEventHandler {
  (event: unknown, context: unknown): unknown
}

async function registerObservability(includeTask: boolean, recommend?: ModelAdvisorExtensionOptions['recommend']) {
  const handlers = new Map<string, RegisteredEventHandler>()
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>()
  const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
  const registerTool: ExtensionAPI['registerTool'] = () => undefined
  const on = ((event: string, handler: unknown) => {
    handlers.set(event, handler as RegisteredEventHandler)
    return () => undefined
  }) as ExtensionAPI['on']
  const api: Pick<ExtensionAPI, 'registerCommand' | 'registerTool' | 'on' | 'appendEntry'> = {
    registerCommand,
    registerTool,
    on,
    appendEntry,
  }
  const configuration = validRecommendationConfiguration()
  if (configuration.status === 'valid') {
    configuration.configuration.logging.includeTask = includeTask
  }
  await registerModelAdvisorExtension(api, {
    loadConfiguration: () => Promise.resolve(configuration),
    recommend,
  })
  const [[, command]] = registerCommand.mock.calls
  return { appendEntry, handlers, configuration, command }
}

function recommendationResult(): Promise<RecommendationResult> {
  return recommendSubagentModel(validRecommendationRequest(), {
    configuration: validRecommendationConfiguration(),
    candidateModels: [chatModel()],
    classify: () => Promise.resolve(validClassifierResult()),
    getSupportedThinkingLevels: () => ['max'] as ModelThinkingLevel[],
    clampThinkingLevel: (_model, level) => level,
  })
}

function observabilityContext() {
  const context = {
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [
        chatModel(),
        chatModel('openai-codex', 'gpt-luna'),
        { ...chatModel(), id: 'pi-virtual', api: 'pi-virtual' },
      ],
    },
  }
  return context as unknown as ExtensionContext
}

async function recordToolResult(includeTask: boolean, resultOverride?: RecommendationResult) {
  const { appendEntry, handlers } = await registerObservability(includeTask)
  const request = validRecommendationRequest()
  const result = resultOverride ?? (await recommendationResult())
  const context = observabilityContext()
  const toolCallId = 'advisor-call-1'

  handlers.get('tool_execution_start')?.(
    { type: 'tool_execution_start', toolCallId, toolName: 'recommend_subagent_model', args: request },
    context,
  )
  handlers.get('tool_result')?.(
    {
      type: 'tool_result',
      toolCallId,
      toolName: 'recommend_subagent_model',
      input: request,
      structuredContent: result,
      isError: false,
      content: [],
    },
    context,
  )
  return { entry: appendEntry.mock.calls[0]?.[1], appendEntry }
}

describe('model advisor observability', () => {
  it('persists bounded recommendation metadata without task state by default', async () => {
    const { entry, appendEntry } = await recordToolResult(false)

    expect(entry).toMatchObject({
      status: 'recommended',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      candidates: [
        { provider: 'openai', model: 'gpt-luna' },
        { provider: 'openai-codex', model: 'gpt-luna' },
      ],
      selection: { provider: 'openai', model: 'gpt-luna', thinking: 'max' },
      answers: { required_capability: { type: 'choice', choice: 'light' }, high_consequence: { type: 'bool' } },
    })
    expect(entry).not.toHaveProperty('taskState')
    expect(JSON.stringify(entry)).not.toContain('Use only the supplied source files and tests.')
    expect(appendEntry).toHaveBeenCalledExactlyOnceWith('pi-model-advisor.recommendation', entry)
  })

  it('retains the complete explicit request only with the includeTask opt-in', async () => {
    const { entry } = await recordToolResult(true)

    expect(entry).toMatchObject({
      taskState: {
        task: 'Implement the classifier recommendation core.',
        taskProfile: {
          name: 'custom_implementation',
          levels: ['light'],
          description: 'Change code and tests for an explicitly scoped implementation task.',
        },
        role: 'implementation worker',
        context: 'Use only the supplied source files and tests.',
        requirements: { allowedProviders: ['openai'], maximumThinking: 'max' },
        levels: ['light'],
      },
    })
  })

  it('records slash-command recommendations through the same task-free metadata path', async () => {
    const recommend: NonNullable<ModelAdvisorExtensionOptions['recommend']> = () => recommendationResult()
    const { appendEntry, command } = await registerObservability(false, recommend)
    const notify = vi.fn<ExtensionCommandContext['ui']['notify']>()
    const context = {
      ...observabilityContext(),
      signal: undefined,
      ui: { notify },
    } as unknown as ExtensionCommandContext

    await command.handler('recommend Sensitive command text.', context)

    const [[customType, entry]] = appendEntry.mock.calls
    expect(customType).toBe('pi-model-advisor.recommendation')
    expect(entry).not.toHaveProperty('taskState')
    expect(JSON.stringify(entry)).not.toContain('Sensitive command text.')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Pi may independently retain'), 'info')
  })

  it('records typed classifier failure categories without retaining raw provider errors', async () => {
    const failure: RecommendationResult = {
      status: 'classifier_failed',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      category: 'transport',
      message: 'raw upstream credential detail',
    }
    const { entry } = await recordToolResult(false, failure)

    expect(entry).toMatchObject({ status: 'classifier_failed', failureCategory: 'transport' })
    expect(JSON.stringify(entry)).not.toContain('raw upstream credential detail')
  })
})
