import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'

import { recommendSubagentModel, type RecommendationDependencies } from './core.ts'
import {
  chatModel,
  validClassifierResult,
  validRecommendationConfiguration,
  validRecommendationRequest,
} from './test-fixtures.ts'
import { RecommendationRequestSchema, RecommendationResultSchema } from './types.ts'

const thinkingHelpers = {
  getSupportedThinkingLevels: (_model: Model<Api>): ModelThinkingLevel[] => [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ],
  clampThinkingLevel: (_model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel => level,
}

describe('recommendSubagentModel', () => {
  it('classifies the explicit task state once and returns a complete structured recommendation', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(validClassifierResult()))
    const result = await recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [chatModel()],
      classify,
      ...thinkingHelpers,
    })

    expect(classify).toHaveBeenCalledTimes(1)
    const [call] = classify.mock.calls
    const [context] = call
    expect(context.state).toEqual({
      task: 'Implement the classifier recommendation core.',
      taskProfile: {
        name: 'custom_implementation',
        description: 'Change code and tests for an explicitly scoped implementation task.',
        levels: ['light'],
      },
      role: 'implementation worker',
      context: 'Use only the supplied source files and tests.',
      requirements: { allowedProviders: ['openai'], maximumThinking: 'max' },
      levels: ['light'],
    })
    expect(Object.keys(context.questions)).toEqual([
      'required_capability',
      'reasoning_effort',
      'context_demand',
      'high_consequence',
    ])
    const capabilityQuestion = context.questions.required_capability
    const capabilityCriteria = capabilityQuestion.type === 'choice' ? capabilityQuestion.criteria : undefined
    expect(capabilityQuestion.type).toBe('choice')
    expect(capabilityCriteria).toEqual({
      light: 'Routine, mechanical, or tightly bounded work.',
      standard: 'Ordinary localized work with multiple steps.',
      advanced: 'Complex cross-component work requiring substantial judgment.',
      frontier: 'Exceptionally difficult work with extensive uncertainty or constraints.',
    })
    expect(context.questions.reasoning_effort.type).toBe('choice')
    expect(context.questions.context_demand.type).toBe('choice')
    expect(context.questions.high_consequence.type).toBe('bool')
    expect(result).toMatchObject({
      status: 'recommended',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      selection: { provider: 'openai', model: 'gpt-luna', thinking: 'max', capability: 'light' },
      policy: {
        taskKind: 'custom_implementation',
        allowedLevels: ['light'],
        automaticLevels: ['light'],
        capabilityPercentile: 75,
        baseCapability: 'light',
        requiredCapability: 'light',
        contextDemand: 'narrow',
        contextWindowPreference: false,
        requestedThinking: 'max',
        permittedThinking: { minimum: 'max', maximum: 'max' },
      },
    })
    expect(Value.Check(RecommendationRequestSchema, validRecommendationRequest())).toBeTruthy()
    expect(Value.Check(RecommendationRequestSchema, { task: 'task', unknown: true })).toBeFalsy()
    if (result.status !== 'recommended') {
      throw new Error('Expected the configured normal-pool candidate.')
    }
    expect(Value.Check(RecommendationResultSchema, result)).toBeTruthy()
    expect(result.usage).toEqual(validClassifierResult().usage)
  })

  it('returns aborted when caller cancellation aborts a pending classifier request', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const classify = vi.fn<RecommendationDependencies['classify']>(
      (_context, { signal }) =>
        new Promise((_, reject) => {
          markStarted()
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Native classifier aborted.'), { name: 'AbortError' })),
            { once: true },
          )
        }),
    )
    const resultPromise = recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [chatModel()],
      classify,
      signal: controller.signal,
      ...thinkingHelpers,
    })

    await started
    controller.abort()
    const result = await resultPromise

    expect(result).toMatchObject({
      status: 'aborted',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
    })
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('returns aborted before a nonresponsive classifier reaches its deadline', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    configuration.configuration.policy.overallDeadlineMs = 20
    const controller = new AbortController()
    let markStarted!: () => void
    let complete!: (result: Awaited<ReturnType<RecommendationDependencies['classify']>>) => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const pendingResult = new Promise<Awaited<ReturnType<RecommendationDependencies['classify']>>>((resolve) => {
      complete = resolve
    })
    const classify = vi.fn<RecommendationDependencies['classify']>(() => {
      markStarted()
      return pendingResult
    })
    const resultPromise = recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [chatModel()],
      classify,
      signal: controller.signal,
      ...thinkingHelpers,
    })

    await started
    controller.abort()
    const result = await resultPromise

    expect(result).toMatchObject({
      status: 'aborted',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
    })
    complete(validClassifierResult())
  })

  it('does not accept a classifier response after caller cancellation', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const controller = new AbortController()
    const classify = vi.fn<RecommendationDependencies['classify']>(() => {
      controller.abort()
      return Promise.resolve(validClassifierResult())
    })
    const result = await recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [chatModel()],
      classify,
      signal: controller.signal,
      ...thinkingHelpers,
    })

    expect(result).toMatchObject({
      status: 'aborted',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
    })
  })

  it('rejects an unknown explicitly selected profile before classifier execution', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(validClassifierResult()))

    await expect(
      recommendSubagentModel(
        { ...validRecommendationRequest(), taskKind: 'not_configured' },
        {
          configuration,
          candidateModels: [chatModel()],
          classify,
          ...thinkingHelpers,
        },
      ),
    ).rejects.toThrow('Unknown task profile')
    expect(classify).not.toHaveBeenCalled()
  })

  it('rejects candidates with invalid token limits while keeping valid alternatives eligible', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const [configuredModel] = configuration.configuration.models.light ?? []
    configuration.configuration.models.light = [
      { ...configuredModel, model: 'invalid-context' },
      { ...configuredModel, model: 'invalid-max-tokens' },
      { ...configuredModel, model: 'valid-alternative' },
    ]
    const invalidContext = { ...chatModel('openai', 'invalid-context'), contextWindow: 0 }
    const invalidMaxTokens = {
      ...chatModel('openai', 'invalid-max-tokens'),
      maxTokens: Number.MAX_SAFE_INTEGER + 1,
    }
    const validAlternative = chatModel('openai', 'valid-alternative')
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(validClassifierResult()))

    const result = await recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [invalidContext, invalidMaxTokens, validAlternative],
      classify,
      ...thinkingHelpers,
    })

    expect(result).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai', model: 'valid-alternative' },
      rejections: [
        { provider: 'openai', model: 'invalid-context', reasons: ['invalid_context_window'] },
        { provider: 'openai', model: 'invalid-max-tokens', reasons: ['invalid_max_tokens'] },
      ],
    })
    expect(Value.Check(RecommendationResultSchema, result)).toBeTruthy()
  })

  it('returns no_eligible_model without classifying when every candidate has invalid token limits', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const [configuredModel] = configuration.configuration.models.light ?? []
    configuration.configuration.models.light = [
      { ...configuredModel, model: 'invalid-context' },
      { ...configuredModel, model: 'invalid-max-tokens' },
    ]
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(validClassifierResult()))
    const result = await recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [
        { ...chatModel('openai', 'invalid-context'), contextWindow: 0 },
        { ...chatModel('openai', 'invalid-max-tokens'), maxTokens: 0 },
      ],
      classify,
      ...thinkingHelpers,
    })

    expect(result).toMatchObject({
      status: 'no_eligible_model',
      rejections: [
        { provider: 'openai', model: 'invalid-context', reasons: ['invalid_context_window'] },
        { provider: 'openai', model: 'invalid-max-tokens', reasons: ['invalid_max_tokens'] },
      ],
    })
    expect(classify).not.toHaveBeenCalled()
    expect(Value.Check(RecommendationResultSchema, result)).toBeTruthy()
  })

  it('returns no_eligible_model without classifying when Pi supplies no physical candidates', async () => {
    const configuration = validRecommendationConfiguration()
    if (configuration.status !== 'valid') {
      throw new Error('Expected valid fixture configuration')
    }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(validClassifierResult()))
    const result = await recommendSubagentModel(validRecommendationRequest(), {
      configuration,
      candidateModels: [],
      classify,
      ...thinkingHelpers,
    })

    expect(classify).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'no_eligible_model',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      rejections: [],
    })
    expect(Value.Check(RecommendationResultSchema, result)).toBeTruthy()
  })
})
