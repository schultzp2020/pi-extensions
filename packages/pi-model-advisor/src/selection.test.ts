import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type ClassifierResult,
  type Model,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import type { AdvisorConfiguration } from './config.ts'
import {
  recommendSubagentModel,
  validateAdvisorConfiguration,
  type Capability,
  type RecommendationRequest,
  type ThinkingLevel,
} from './core.ts'
import { chatModel, validClassifierResult } from './test-fixtures.ts'

interface ClassifierOverrides {
  capability?: Capability
  reasoningEffort?: ThinkingLevel
  contextDemand?: 'narrow' | 'moderate' | 'broad' | 'exceptional'
  consequenceProbability?: number
}

function classifierResult(overrides: ClassifierOverrides = {}): ClassifierResult {
  const base = validClassifierResult()
  const capability = overrides.capability ?? 'light'
  const effort = overrides.reasoningEffort ?? 'max'
  const demand = overrides.contextDemand ?? 'narrow'
  return {
    ...base,
    answers: {
      required_capability: {
        type: 'choice',
        choice: capability,
        probabilities: {
          light: capability === 'light' ? 1 : 0,
          standard: capability === 'standard' ? 1 : 0,
          advanced: capability === 'advanced' ? 1 : 0,
          frontier: capability === 'frontier' ? 1 : 0,
        },
        confidence: 1,
      },
      reasoning_effort: {
        type: 'choice',
        choice: effort,
        probabilities: {
          off: effort === 'off' ? 1 : 0,
          minimal: effort === 'minimal' ? 1 : 0,
          low: effort === 'low' ? 1 : 0,
          medium: effort === 'medium' ? 1 : 0,
          high: effort === 'high' ? 1 : 0,
          xhigh: effort === 'xhigh' ? 1 : 0,
          max: effort === 'max' ? 1 : 0,
        },
        confidence: 1,
      },
      context_demand: {
        type: 'choice',
        choice: demand,
        probabilities: {
          narrow: demand === 'narrow' ? 1 : 0,
          moderate: demand === 'moderate' ? 1 : 0,
          broad: demand === 'broad' ? 1 : 0,
          exceptional: demand === 'exceptional' ? 1 : 0,
        },
        confidence: 1,
      },
      high_consequence: {
        type: 'bool',
        probability: overrides.consequenceProbability ?? 0.1,
      },
    },
  }
}

function configuration(
  models: Partial<Record<Capability, { provider: string; model: string; priority?: number; thinking?: object }[]>>,
  tasks: Record<string, unknown> = { custom_implementation: ['light'] },
  thinking?: object,
): AdvisorConfiguration {
  const result = validateAdvisorConfiguration({
    classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
    models,
    tasks,
    ...(thinking ? { thinking } : {}),
  })
  if (result.status !== 'valid') {
    throw new Error(`Expected valid test configuration: ${JSON.stringify(result.issues)}`)
  }
  return result.configuration
}

function modelConfiguration(provider: string, model: string, thinking?: object, priority?: number) {
  return {
    provider,
    model,
    ...(thinking ? { thinking } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

function request(overrides: Partial<RecommendationRequest> = {}): RecommendationRequest {
  return {
    task: 'Select a model for this explicit test task.',
    taskKind: 'custom_implementation',
    requirements: { maximumThinking: 'max' },
    ...overrides,
  }
}

async function recommend(input: {
  configuration: AdvisorConfiguration
  candidateModels: readonly Model<Api>[]
  request?: RecommendationRequest
  classifier?: ClassifierResult
}) {
  return recommendSubagentModel(input.request ?? request(), {
    configuration: { status: 'valid', configuration: input.configuration },
    candidateModels: input.candidateModels,
    classify: () => Promise.resolve(input.classifier ?? classifierResult()),
    getSupportedThinkingLevels,
    clampThinkingLevel,
  })
}

describe('recommendSubagentModel selection', () => {
  it('prefers known context capacity over invalid metadata for broad-context tasks', async () => {
    const unknownContext = { ...chatModel('openai', 'gpt-unknown-context'), contextWindow: Number.NaN }
    const knownContext = { ...chatModel('openai-codex', 'gpt-known-context'), contextWindow: 128_000 }
    const result = await recommend({
      configuration: configuration({
        light: [
          modelConfiguration('openai', 'gpt-unknown-context', { minimum: 'max', maximum: 'max' }),
          modelConfiguration('openai-codex', 'gpt-known-context', { minimum: 'max', maximum: 'max' }),
        ],
      }),
      candidateModels: [unknownContext, knownContext],
      classifier: classifierResult({ contextDemand: 'broad' }),
    })

    expect(result).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai-codex', model: 'gpt-known-context', thinking: 'max', capability: 'light' },
      policy: { contextWindowPreference: true },
    })
  })

  it('enforces image, context, provider, and request-level bounds independently', async () => {
    const result = await recommend({
      configuration: configuration(
        {
          light: [
            modelConfiguration('openai-codex', 'eligible', { minimum: 'max', maximum: 'max' }),
            modelConfiguration('openai-codex', 'no-image', { minimum: 'max', maximum: 'max' }),
            modelConfiguration('openai-codex', 'small-context', { minimum: 'max', maximum: 'max' }),
            modelConfiguration('openai', 'wrong-provider', { minimum: 'max', maximum: 'max' }),
          ],
          standard: [modelConfiguration('openai-codex', 'outside-request-level')],
        },
        { custom_implementation: { description: 'A caller-scoped normal pool.', levels: ['light'] } },
      ),
      candidateModels: [
        { ...chatModel('openai-codex', 'eligible'), input: ['text', 'image'], contextWindow: 64_000 },
        { ...chatModel('openai-codex', 'no-image'), contextWindow: 64_000 },
        { ...chatModel('openai-codex', 'small-context'), input: ['text', 'image'], contextWindow: 8_000 },
        { ...chatModel('openai', 'wrong-provider'), input: ['text', 'image'], contextWindow: 64_000 },
        { ...chatModel('openai-codex', 'outside-request-level'), input: ['text', 'image'], contextWindow: 64_000 },
      ],
      request: request({
        requirements: {
          imageInput: true,
          minimumContextWindow: 32_000,
          allowedProviders: ['openai-codex'],
          maximumThinking: 'max',
        },
        levels: ['light'],
      }),
    })

    expect(result).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai-codex', model: 'eligible', capability: 'light' },
    })
    if (result.status !== 'recommended') {
      throw new Error('Expected the hard-compatible candidate.')
    }
    expect(result.rejections).toEqual(
      expect.arrayContaining([
        { provider: 'openai-codex', model: 'no-image', reasons: ['image_unsupported'] },
        { provider: 'openai-codex', model: 'small-context', reasons: ['context_insufficient'] },
        { provider: 'openai', model: 'wrong-provider', reasons: ['provider_excluded'] },
        { provider: 'openai-codex', model: 'outside-request-level', reasons: ['caller_level_excluded'] },
      ]),
    )
  })

  it('keeps task levels as the normal pool and requires approval for sufficient stronger models', async () => {
    const models = {
      light: [modelConfiguration('openai', 'gpt-luna', { minimum: 'max', maximum: 'max' })],
      standard: [modelConfiguration('openai-codex', 'gpt-sol')],
      advanced: [modelConfiguration('openai', 'gpt-sol-advanced')],
    }
    const candidates = [
      chatModel('openai', 'gpt-luna'),
      chatModel('openai-codex', 'gpt-sol'),
      chatModel('openai', 'gpt-sol-advanced'),
    ]
    const configurationWithImplementation = configuration(models, {
      custom_implementation: { description: 'Routine implementation work.', levels: ['light'] },
    })
    const stronger = await recommend({
      configuration: configurationWithImplementation,
      candidateModels: candidates,
      request: request({ taskKind: 'custom_implementation' }),
      classifier: classifierResult({ capability: 'standard' }),
    })

    expect(stronger).toMatchObject({
      status: 'approval_required',
      selection: { provider: 'openai-codex', model: 'gpt-sol', thinking: 'max', capability: 'standard' },
      policy: { automaticLevels: ['light'], requiredCapability: 'standard' },
    })

    const hardNarrowed = await recommend({
      configuration: configurationWithImplementation,
      candidateModels: candidates,
      request: request({ taskKind: 'custom_implementation', levels: ['light'] }),
      classifier: classifierResult({ capability: 'standard' }),
    })
    expect(hardNarrowed).toMatchObject({ status: 'no_eligible_model' })
    if (hardNarrowed.status !== 'no_eligible_model') {
      throw new Error('Expected the hard request level to block every stronger model.')
    }
    expect(hardNarrowed.rejections).toEqual(
      expect.arrayContaining([
        { provider: 'openai', model: 'gpt-luna', reasons: ['capability_insufficient'] },
        { provider: 'openai-codex', model: 'gpt-sol', reasons: ['caller_level_excluded'] },
        { provider: 'openai', model: 'gpt-sol-advanced', reasons: ['caller_level_excluded'] },
      ]),
    )
  })

  it('distinguishes omitted task rules from empty task and request level lists', async () => {
    const standardConfiguration = configuration({ standard: [modelConfiguration('openai', 'gpt-standard')] })
    const omittedTask = request({ taskKind: undefined })
    delete omittedTask.taskKind
    const withoutProfile = await recommend({
      configuration: standardConfiguration,
      candidateModels: [chatModel('openai', 'gpt-standard')],
      request: omittedTask,
      classifier: classifierResult({ capability: 'standard' }),
    })
    expect(withoutProfile).toMatchObject({
      status: 'recommended',
      selection: { model: 'gpt-standard', capability: 'standard' },
      policy: { automaticLevels: ['light', 'standard', 'advanced', 'frontier'] },
    })

    const emptyTask = await recommend({
      configuration: configuration(
        { light: [modelConfiguration('openai', 'gpt-luna')] },
        { custom_implementation: [] },
      ),
      candidateModels: [chatModel()],
    })
    expect(emptyTask).toMatchObject({ status: 'no_eligible_model', rejections: [{ reasons: ['task_blocked'] }] })
    if (emptyTask.status !== 'no_eligible_model') {
      throw new Error('Expected an empty task level list to block both pools.')
    }
    expect(emptyTask.answers).toBeUndefined()

    const emptyRequest = await recommend({
      configuration: configuration({ light: [modelConfiguration('openai', 'gpt-luna')] }),
      candidateModels: [chatModel()],
      request: request({ levels: [] }),
    })
    expect(emptyRequest).toMatchObject({ status: 'no_eligible_model', rejections: [{ reasons: ['task_blocked'] }] })
    if (emptyRequest.status !== 'no_eligible_model') {
      throw new Error('Expected an empty request level list to block both pools.')
    }
    expect(emptyRequest.answers).toBeUndefined()
  })

  it('ranks by capability, priority, context preference, price components, and exact identity', async () => {
    const models = {
      standard: [
        modelConfiguration('z-provider', 'a-output-cost', undefined, 0),
        modelConfiguration('z-provider', 'b-input-cost', undefined, 0),
        modelConfiguration('z-provider', 'c-cache-cost', undefined, 0),
        modelConfiguration('z-provider', 'd-tie', undefined, 0),
        modelConfiguration('a-provider', 'z-tie', undefined, 0),
        modelConfiguration('a-provider', 'e-tie', undefined, 0),
      ],
      advanced: [modelConfiguration('priority-cannot-beat-capability', 'gpt-advanced', undefined, 1000)],
    }
    const pricedModel = (provider: string, id: string, output: number, input: number, cacheRead: number) => ({
      ...chatModel(provider, id),
      contextWindow: 32_000,
      cost: { input, output, cacheRead, cacheWrite: 0 },
    })
    const result = await recommend({
      configuration: configuration(models),
      candidateModels: [
        pricedModel('z-provider', 'a-output-cost', 2, 0, 0),
        pricedModel('z-provider', 'b-input-cost', 1, 9, 0),
        pricedModel('z-provider', 'c-cache-cost', 1, 4, 9),
        pricedModel('z-provider', 'd-tie', 1, 4, 1),
        pricedModel('a-provider', 'z-tie', 1, 4, 1),
        pricedModel('a-provider', 'e-tie', 1, 4, 1),
        {
          ...chatModel('priority-cannot-beat-capability', 'gpt-advanced'),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      request: request({ taskKind: undefined }),
      classifier: classifierResult({ capability: 'standard' }),
    })

    expect(result).toMatchObject({
      status: 'recommended',
      selection: { provider: 'a-provider', model: 'e-tie', capability: 'standard' },
    })
  })

  it('prefers larger context only after equal user priority for broad-context work', async () => {
    const result = await recommend({
      configuration: configuration({
        light: [
          modelConfiguration('openai', 'smaller-context', { minimum: 'max', maximum: 'max' }, 4),
          modelConfiguration('openai-codex', 'larger-context', { minimum: 'max', maximum: 'max' }, 4),
        ],
      }),
      candidateModels: [
        { ...chatModel('openai', 'smaller-context'), contextWindow: 32_000 },
        { ...chatModel('openai-codex', 'larger-context'), contextWindow: 128_000 },
      ],
      classifier: classifierResult({ contextDemand: 'exceptional' }),
    })

    expect(result).toMatchObject({ status: 'recommended', selection: { model: 'larger-context' } })
  })

  it('uses user priority before a larger context window', async () => {
    const result = await recommend({
      configuration: configuration({
        light: [
          modelConfiguration('openai', 'priority-winner', { minimum: 'max', maximum: 'max' }, 5),
          modelConfiguration('openai-codex', 'context-winner', { minimum: 'max', maximum: 'max' }, 4),
        ],
      }),
      candidateModels: [
        { ...chatModel('openai', 'priority-winner'), contextWindow: 32_000 },
        { ...chatModel('openai-codex', 'context-winner'), contextWindow: 128_000 },
      ],
      classifier: classifierResult({ contextDemand: 'broad' }),
    })

    expect(result).toMatchObject({ status: 'recommended', selection: { model: 'priority-winner' } })
  })

  it('ranks known zero prices before missing prices', async () => {
    const result = await recommend({
      configuration: configuration({
        light: [
          modelConfiguration('a-provider', 'missing-price', { minimum: 'max', maximum: 'max' }),
          modelConfiguration('z-provider', 'zero-price', { minimum: 'max', maximum: 'max' }),
        ],
      }),
      candidateModels: [
        {
          ...chatModel('a-provider', 'missing-price'),
          cost: { input: 0, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
        },
        { ...chatModel('z-provider', 'zero-price'), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    })

    expect(result).toMatchObject({ status: 'recommended', selection: { provider: 'z-provider', model: 'zero-price' } })
  })

  it('keeps exact provider identities distinct when model IDs match', async () => {
    const result = await recommend({
      configuration: configuration({
        light: [
          modelConfiguration('openai', 'shared-id', { minimum: 'max', maximum: 'max' }),
          modelConfiguration('openai-codex', 'shared-id', { minimum: 'max', maximum: 'max' }),
        ],
      }),
      candidateModels: [chatModel('openai', 'shared-id'), chatModel('openai-codex', 'shared-id')],
      request: request({ requirements: { allowedProviders: ['openai-codex'], maximumThinking: 'max' } }),
    })

    expect(result).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai-codex', model: 'shared-id', thinking: 'max', capability: 'light' },
    })
  })

  it('uses native sparse-level resolution and never crosses caller thinking bounds', async () => {
    const sparseModel = {
      ...chatModel('openai', 'sparse-levels'),
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null, xhigh: 'xhigh', max: null },
    }
    const sparseConfiguration = configuration({ light: [modelConfiguration('openai', 'sparse-levels')] })
    const unbounded = await recommend({
      configuration: sparseConfiguration,
      candidateModels: [sparseModel],
      classifier: classifierResult({ reasoningEffort: 'medium' }),
    })
    expect(unbounded).toMatchObject({ status: 'recommended', selection: { thinking: 'xhigh' } })

    const capped = await recommend({
      configuration: sparseConfiguration,
      candidateModels: [sparseModel],
      request: request({ requirements: { maximumThinking: 'high' } }),
      classifier: classifierResult({ reasoningEffort: 'medium' }),
    })
    expect(capped).toMatchObject({ status: 'recommended', selection: { thinking: 'low' } })

    const minimumBounded = await recommend({
      configuration: sparseConfiguration,
      candidateModels: [sparseModel],
      request: request({ requirements: { minimumThinking: 'high', maximumThinking: 'xhigh' } }),
      classifier: classifierResult({ reasoningEffort: 'low' }),
    })
    expect(minimumBounded).toMatchObject({ status: 'recommended', selection: { thinking: 'xhigh' } })

    const noSupportedLevel = await recommend({
      configuration: sparseConfiguration,
      candidateModels: [sparseModel],
      request: request({ requirements: { minimumThinking: 'high', maximumThinking: 'high' } }),
    })
    expect(noSupportedLevel).toMatchObject({
      status: 'no_eligible_model',
      rejections: [{ reasons: ['thinking_incompatible'] }],
    })
  })

  it('returns configuration_error for configured ranges with no native supported level', async () => {
    const result = await recommend({
      configuration: configuration({
        light: [modelConfiguration('openai', 'sparse-levels', { minimum: 'max', maximum: 'max' })],
      }),
      candidateModels: [
        {
          ...chatModel('openai', 'sparse-levels'),
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: 'low',
            medium: null,
            high: null,
            xhigh: 'xhigh',
            max: null,
          },
        },
      ],
    })

    expect(result).toMatchObject({ status: 'configuration_error', issues: [{ code: 'unsupported_thinking' }] })
  })

  it('supports non-reasoning models only at off and rejects inverted caller bounds', async () => {
    const nonReasoning = { ...chatModel('openai', 'non-reasoning'), reasoning: false }
    const config = configuration({ light: [modelConfiguration('openai', 'non-reasoning')] })
    const supported = await recommend({
      configuration: config,
      candidateModels: [nonReasoning],
      classifier: classifierResult({ reasoningEffort: 'max' }),
    })
    expect(supported).toMatchObject({ status: 'recommended', selection: { thinking: 'off' } })

    const callerExcluded = await recommend({
      configuration: config,
      candidateModels: [nonReasoning],
      request: request({ requirements: { minimumThinking: 'low', maximumThinking: 'max' } }),
    })
    expect(callerExcluded).toMatchObject({
      status: 'no_eligible_model',
      rejections: [{ reasons: ['thinking_incompatible'] }],
    })

    await expect(
      recommend({
        configuration: config,
        candidateModels: [nonReasoning],
        request: request({ requirements: { minimumThinking: 'high', maximumThinking: 'low' } }),
      }),
    ).rejects.toThrow('minimumThinking must not exceed maximumThinking')
  })

  it('preserves Luna max-only work and personal identities and excludes lower caller ceilings', async () => {
    const lunaRange = { minimum: 'max', maximum: 'max' }
    const config = configuration({
      light: [
        modelConfiguration('openai', 'gpt-6-luna', lunaRange),
        modelConfiguration('openai-codex', 'gpt-6-luna', lunaRange),
      ],
    })
    const candidates = [chatModel('openai', 'gpt-6-luna'), chatModel('openai-codex', 'gpt-6-luna')]
    const exactMax = await recommend({
      configuration: config,
      candidateModels: candidates,
      request: request({ requirements: { allowedProviders: ['openai-codex'], maximumThinking: 'max' } }),
    })
    expect(exactMax).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'max', capability: 'light' },
    })

    const lowerCeiling = await recommend({
      configuration: config,
      candidateModels: candidates,
      request: request({ requirements: { allowedProviders: ['openai-codex'], maximumThinking: 'high' } }),
    })
    expect(lowerCeiling).toMatchObject({ status: 'no_eligible_model' })
    if (lowerCeiling.status !== 'no_eligible_model') {
      throw new Error('Expected the lower caller ceiling to exclude max-only Luna.')
    }
    expect(lowerCeiling.rejections).toContainEqual({
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      reasons: ['thinking_incompatible'],
    })

    const maxEffortDoesNotRaiseCapability = await recommend({
      configuration: configuration({
        light: [modelConfiguration('openai', 'gpt-6-luna', lunaRange)],
        standard: [modelConfiguration('openai-codex', 'gpt-6-sol')],
      }),
      candidateModels: [chatModel('openai', 'gpt-6-luna'), chatModel('openai-codex', 'gpt-6-sol')],
      classifier: classifierResult({ reasoningEffort: 'max' }),
    })
    expect(maxEffortDoesNotRaiseCapability).toMatchObject({
      status: 'recommended',
      selection: { provider: 'openai', model: 'gpt-6-luna', thinking: 'max', capability: 'light' },
    })
  })
})
