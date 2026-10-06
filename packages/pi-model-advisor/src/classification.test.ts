import type { Api, ClassifierResult, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'

import { recommendSubagentModel, type RecommendationDependencies } from './core.ts'
import {
  chatModel,
  validClassifierResult,
  validRecommendationConfiguration,
  validRecommendationRequest,
} from './test-fixtures.ts'

const validNativeResult = validClassifierResult()
const validCapabilityAnswer = validNativeResult.answers.required_capability
const validEffortAnswer = validNativeResult.answers.reasoning_effort
const validContextAnswer = validNativeResult.answers.context_demand
if (
  validCapabilityAnswer.type !== 'choice' ||
  validEffortAnswer.type !== 'choice' ||
  validContextAnswer.type !== 'choice'
) {
  throw new Error('Expected choice fixture answers')
}

const malformedNativeResults: [string, ClassifierResult][] = [
  [
    'unexpected question key',
    { ...validNativeResult, answers: { ...validNativeResult.answers, unknown_question: validCapabilityAnswer } },
  ],
  [
    'missing question key',
    {
      ...validNativeResult,
      answers: {
        required_capability: validNativeResult.answers.required_capability,
        reasoning_effort: validNativeResult.answers.reasoning_effort,
        high_consequence: validNativeResult.answers.high_consequence,
      },
    },
  ],
  [
    'wrong answer type',
    {
      ...validNativeResult,
      answers: { ...validNativeResult.answers, required_capability: { type: 'bool', probability: 0.5 } },
    },
  ],
  [
    'unknown choice label',
    {
      ...validNativeResult,
      answers: { ...validNativeResult.answers, required_capability: { ...validCapabilityAnswer, choice: 'unknown' } },
    },
  ],
  [
    'unknown effort label',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        reasoning_effort: { ...validEffortAnswer, choice: 'unknown' },
      },
    },
  ],
  [
    'unknown context label',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        context_demand: { ...validContextAnswer, choice: 'unknown' },
      },
    },
  ],
  [
    'missing distribution entry',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { light: 1, standard: 0, advanced: 0 },
        },
      },
    },
  ],
  [
    'unknown distribution entry',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { ...validCapabilityAnswer.probabilities, unknown: 0 },
        },
      },
    },
  ],
  [
    'nonfinite probability',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { ...validCapabilityAnswer.probabilities, light: Number.NaN },
        },
      },
    },
  ],
  [
    'out-of-range distribution probability',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { ...validCapabilityAnswer.probabilities, light: 1.01 },
        },
      },
    },
  ],
  [
    'out-of-range confidence',
    {
      ...validNativeResult,
      answers: { ...validNativeResult.answers, required_capability: { ...validCapabilityAnswer, confidence: 1.01 } },
    },
  ],
  [
    'distribution outside probability tolerance',
    {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { light: 0.8, standard: 0.2, advanced: 0.1, frontier: 0 },
        },
      },
    },
  ],
  [
    'out-of-range bool probability',
    {
      ...validNativeResult,
      answers: { ...validNativeResult.answers, high_consequence: { type: 'bool', probability: 2 } },
    },
  ],
  ['classifier provider identity mismatch', { ...validNativeResult, provider: 'other-provider' }],
  ['classifier model identity mismatch', { ...validNativeResult, model: 'other-model' }],
]

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

function recommendWithClassifier(
  classify: RecommendationDependencies['classify'],
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
) {
  const configuration = validRecommendationConfiguration()
  if (configuration.status !== 'valid') {
    throw new Error('Expected valid fixture configuration')
  }
  if (options.deadlineMs !== undefined) {
    configuration.configuration.policy.overallDeadlineMs = options.deadlineMs
  }
  return recommendSubagentModel(validRecommendationRequest(), {
    configuration,
    candidateModels: [chatModel()],
    classify,
    signal: options.signal,
    ...thinkingHelpers,
  })
}

describe('recommendSubagentModel classifier lifecycle', () => {
  it.each([
    ['native error stop reason', { stopReason: 'error' as const, errorMessage: 'Provider request failed.' }],
    ['native error message', { errorMessage: 'Provider request failed.' }],
  ])('returns transport failure for a %s and preserves usage', async (_description, nativeError) => {
    const response = { ...validClassifierResult(), ...nativeError }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(response))

    const result = await recommendWithClassifier(classify)

    expect(result).toMatchObject({
      status: 'classifier_failed',
      category: 'transport',
      message: 'Classifier request failed.',
      usage: validClassifierResult().usage,
    })
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('returns a generic transport failure when the injected classifier rejects', async () => {
    const classify = vi.fn<RecommendationDependencies['classify']>(() =>
      Promise.reject(new Error('Provider response contains private diagnostics.')),
    )

    const result = await recommendWithClassifier(classify)

    expect(result).toMatchObject({
      status: 'classifier_failed',
      category: 'transport',
      message: 'Classifier request failed.',
    })
    expect(JSON.stringify(result)).not.toContain('private diagnostics')
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it.each(malformedNativeResults)(
    'rejects %s and preserves usage without another inference call',
    async (_name, response) => {
      const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(response))

      const result = await recommendWithClassifier(classify)

      expect(result).toMatchObject({
        status: 'classifier_failed',
        category: 'invalid_answer',
        message: 'Classifier returned invalid answers.',
        usage: validNativeResult.usage,
      })
      expect(classify).toHaveBeenCalledTimes(1)
    },
  )

  it('propagates caller cancellation and clears the overall deadline timer', async () => {
    const caller = new AbortController()
    let nativeSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const classify = vi.fn<RecommendationDependencies['classify']>(
      (_context, options) =>
        new Promise(() => {
          nativeSignal = options.signal
          markStarted()
        }),
    )

    vi.useFakeTimers()
    try {
      const resultPromise = recommendWithClassifier(classify, { signal: caller.signal })
      await started
      expect(vi.getTimerCount()).toBe(1)
      caller.abort()
      const result = await resultPromise

      expect(result).toMatchObject({
        status: 'aborted',
        classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      })
      expect(nativeSignal?.aborted).toBeTruthy()
      expect(classify).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a deadline failure and aborts native attempts at the configured deadline', async () => {
    let nativeSignal: AbortSignal | undefined
    const classify = vi.fn<RecommendationDependencies['classify']>(
      (_context, options) =>
        new Promise(() => {
          nativeSignal = options.signal
        }),
    )

    vi.useFakeTimers()
    try {
      const resultPromise = recommendWithClassifier(classify, { deadlineMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      const result = await resultPromise

      expect(result).toMatchObject({
        status: 'classifier_failed',
        category: 'deadline',
        message: 'Classifier deadline exceeded.',
      })
      expect(nativeSignal?.aborted).toBeTruthy()
      expect(classify).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes accepted probability rounding drift before recommendation', async () => {
    const response: ClassifierResult = {
      ...validNativeResult,
      answers: {
        ...validNativeResult.answers,
        required_capability: {
          ...validCapabilityAnswer,
          probabilities: { light: 0.99995, standard: 0, advanced: 0, frontier: 0 },
        },
      },
    }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(response))

    const result = await recommendWithClassifier(classify)

    if (result.status !== 'recommended') {
      throw new Error('Expected a recommendation from the valid rounded distribution')
    }
    expect(result.answers.required_capability.probabilities.light).toBe(1)
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('returns aborted when Pi reports a native classifier cancellation', async () => {
    const response = { ...validNativeResult, stopReason: 'aborted' as const }
    const classify = vi.fn<RecommendationDependencies['classify']>(() => Promise.resolve(response))

    const result = await recommendWithClassifier(classify)

    expect(result).toMatchObject({
      status: 'aborted',
      classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
      usage: validNativeResult.usage,
    })
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('honors long valid deadlines without overflowing Pi timer limits', async () => {
    const classify = vi.fn<RecommendationDependencies['classify']>(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(validClassifierResult()), 5)
        }),
    )

    const result = await recommendWithClassifier(classify, { deadlineMs: 2_147_483_648 })

    expect(result.status).toBe('recommended')
    expect(classify).toHaveBeenCalledTimes(1)
  })
})
