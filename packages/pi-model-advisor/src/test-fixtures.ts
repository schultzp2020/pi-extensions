import type { Api, ClassifierResult, Model } from '@earendil-works/pi-ai'

import { validateAdvisorConfiguration, type ConfigurationResult } from './config.ts'
import type { RecommendationRequest } from './types.ts'

export function validRecommendationConfiguration(): ConfigurationResult {
  const result = validateAdvisorConfiguration({
    classifier: { provider: 'llama.cpp', model: 'offline-classifier' },
    models: {
      light: [
        {
          provider: 'openai',
          model: 'gpt-luna',
          thinking: { minimum: 'max', maximum: 'max' },
        },
      ],
    },
    tasks: {
      custom_implementation: {
        description: 'Change code and tests for an explicitly scoped implementation task.',
        levels: ['light'],
      },
    },
  })
  if (result.status !== 'valid') {
    throw new Error('Offline fixture configuration must be valid.')
  }
  return result
}

export function validRecommendationRequest(): RecommendationRequest {
  return {
    task: 'Implement the classifier recommendation core.',
    taskKind: 'custom_implementation',
    role: 'implementation worker',
    context: 'Use only the supplied source files and tests.',
    requirements: { allowedProviders: ['openai'], maximumThinking: 'max' },
    levels: ['light'],
  }
}

export function chatModel(provider = 'openai', id = 'gpt-luna'): Model<Api> {
  return {
    provider,
    id,
    api: 'openai-completions',
    name: id,
    baseUrl: 'https://example.invalid/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    thinkingLevelMap: { max: 'max' },
    contextWindow: 128_000,
    maxTokens: 8_000,
  }
}

export function validClassifierResult(): ClassifierResult {
  return {
    api: 'llama-cpp-classify',
    provider: 'llama.cpp',
    model: 'offline-classifier',
    timestamp: 1,
    stopReason: 'stop',
    usage: {
      input: 12,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
      totalTokens: 15,
      cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
    },
    answers: {
      required_capability: {
        type: 'choice',
        choice: 'light',
        probabilities: { light: 1, standard: 0, advanced: 0, frontier: 0 },
        confidence: 1,
      },
      reasoning_effort: {
        type: 'choice',
        choice: 'max',
        probabilities: { off: 0, minimal: 0, low: 0, medium: 0, high: 0, xhigh: 0, max: 1 },
        confidence: 1,
      },
      context_demand: {
        type: 'choice',
        choice: 'narrow',
        probabilities: { narrow: 1, moderate: 0, broad: 0, exceptional: 0 },
        confidence: 1,
      },
      high_consequence: { type: 'bool', probability: 0.1 },
    },
  }
}
