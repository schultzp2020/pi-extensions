import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'

import { RECOMMENDATION_TOOL_NAME, type RecommendationContext } from './adapter.ts'
import { createClassifierContext } from './classification.ts'
import type { ConfigurationResult, ModelIdentity } from './config.ts'
import type { RecommendationRequest, RecommendationResult } from './types.ts'
import { RecommendationRequestSchema, RecommendationResultSchema } from './types.ts'

const RECOMMENDATION_LOG_ENTRY_TYPE = 'pi-model-advisor.recommendation'

export type RecommendationRecorder = (
  request: RecommendationRequest,
  result: RecommendationResult,
  context: RecommendationContext,
) => void

function compareIdentity(left: ModelIdentity, right: ModelIdentity): number {
  if (left.provider !== right.provider) {
    return left.provider < right.provider ? -1 : 1
  }
  if (left.model !== right.model) {
    return left.model < right.model ? -1 : 1
  }
  return 0
}

function candidateIdentities(context: Pick<ExtensionContext, 'modelRegistry' | 'scopedModels'>): ModelIdentity[] {
  try {
    const models =
      context.scopedModels.length > 0
        ? context.scopedModels.map(({ model }) => model)
        : context.modelRegistry.getAvailable()
    const identities = new Map<string, ModelIdentity>()
    for (const model of models) {
      if (model.api === 'pi-virtual' || !model.provider.trim() || !model.id.trim()) {
        continue
      }
      const identity = { provider: model.provider, model: model.id }
      identities.set(JSON.stringify([identity.provider, identity.model]), identity)
    }
    return [...identities.values()].sort(compareIdentity)
  } catch {
    return []
  }
}

function recommendationMetadata(
  request: RecommendationRequest,
  result: RecommendationResult,
  candidates: readonly ModelIdentity[],
  configuration: ConfigurationResult,
): Record<string, unknown> {
  const classifier =
    'classifier' in result
      ? result.classifier
      : configuration.status === 'valid'
        ? configuration.configuration.classifier
        : undefined
  const failureCategory =
    result.status === 'classifier_failed'
      ? result.category
      : result.status === 'recommended' || result.status === 'approval_required'
        ? undefined
        : result.status
  return {
    version: 1,
    status: result.status,
    ...(classifier ? { classifier } : {}),
    candidates: [...candidates],
    ...('answers' in result && result.answers ? { answers: result.answers } : {}),
    ...('selection' in result ? { selection: result.selection } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    ...(configuration.status === 'valid' && configuration.configuration.logging.includeTask
      ? { taskState: createClassifierContext(request, configuration.configuration).state }
      : {}),
  }
}

export function registerModelAdvisorObservability(
  pi: Pick<ExtensionAPI, 'on' | 'appendEntry'>,
  configuration: ConfigurationResult,
): RecommendationRecorder {
  const candidatesByCallId = new Map<string, ModelIdentity[]>()
  const record: RecommendationRecorder = (request, result, context) => {
    if (!Value.Check(RecommendationRequestSchema, request) || !Value.Check(RecommendationResultSchema, result)) {
      return
    }
    const candidates = candidateIdentities(context)
    const data = recommendationMetadata(request, result, candidates, configuration)
    pi.appendEntry(RECOMMENDATION_LOG_ENTRY_TYPE, structuredClone(data))
  }

  pi.on('tool_execution_start', (event, context) => {
    if (event.toolName === RECOMMENDATION_TOOL_NAME) {
      candidatesByCallId.set(event.toolCallId, candidateIdentities(context))
    }
  })
  pi.on('tool_result', (event, context) => {
    if (event.toolName !== RECOMMENDATION_TOOL_NAME) {
      return
    }
    const candidates = candidatesByCallId.get(event.toolCallId) ?? candidateIdentities(context)
    candidatesByCallId.delete(event.toolCallId)
    if (
      !Value.Check(RecommendationRequestSchema, event.input) ||
      !Value.Check(RecommendationResultSchema, event.structuredContent)
    ) {
      return
    }
    const request = event.input
    const result = event.structuredContent
    const data = recommendationMetadata(request, result, candidates, configuration)
    pi.appendEntry(RECOMMENDATION_LOG_ENTRY_TYPE, structuredClone(data))
  })

  return record
}
