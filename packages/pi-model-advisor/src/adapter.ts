import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AuthOperationOptions,
  type JsonValue,
  type ModelType,
  type Usage,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import { discoverAdvisorModels, type AdvisorModelRegistry, type ConfigurationResult } from './config.ts'
import { recommendSubagentModel } from './core.ts'
import {
  RecommendationRequestSchema,
  RecommendationResultSchema,
  type RecommendationRequest,
  type RecommendationResult,
} from './types.ts'

export const RECOMMENDATION_TOOL_NAME = 'recommend_subagent_model'

export type RecommendationContext = Pick<ExtensionContext, 'modelRegistry' | 'scopedModels' | 'signal'>

export async function recommendWithPi(
  request: RecommendationRequest,
  configuration: ConfigurationResult,
  context: RecommendationContext,
  signal = context.signal,
): Promise<RecommendationResult> {
  if (signal?.aborted) {
    return {
      status: 'aborted',
      ...(configuration.status === 'valid' ? { classifier: configuration.configuration.classifier } : {}),
    }
  }
  if (configuration.status === 'configuration_error') {
    return { status: 'configuration_error', issues: configuration.issues }
  }

  const { modelRegistry } = context
  const discoveryRegistry: AdvisorModelRegistry = {
    getAvailable: () => modelRegistry.getAvailable(),
    getAvailableOfType: <TType extends ModelType>(type: TType, provider?: string, options?: AuthOperationOptions) =>
      modelRegistry.getAvailableOfType(type, provider, signal ? { ...options, signal } : options),
  }
  let resolveCallerAbort: () => void = () => undefined
  const callerAbort = new Promise<{ cancelled: true }>((resolve) => {
    resolveCallerAbort = () => resolve({ cancelled: true })
  })
  const handleAbort = () => resolveCallerAbort()
  signal?.addEventListener('abort', handleAbort, { once: true })
  let inventory: Awaited<ReturnType<typeof discoverAdvisorModels>>
  try {
    const outcome = await Promise.race([
      discoverAdvisorModels(configuration, discoveryRegistry, context.scopedModels),
      callerAbort,
    ])
    if (signal?.aborted || 'cancelled' in outcome) {
      return { status: 'aborted', classifier: configuration.configuration.classifier }
    }
    inventory = outcome
  } finally {
    signal?.removeEventListener('abort', handleAbort)
  }
  if (inventory.status === 'configuration_error') {
    if (signal?.aborted) {
      return { status: 'aborted', classifier: configuration.configuration.classifier }
    }
    return { status: 'configuration_error', issues: inventory.issues }
  }

  const classifier = modelRegistry.getModelOfType(
    'classifier',
    configuration.configuration.classifier.provider,
    configuration.configuration.classifier.model,
  )
  if (!classifier) {
    return {
      status: 'configuration_error',
      issues: [
        {
          path: '/classifier',
          code: 'classifier_unavailable',
          message: 'Configured classifier is not available in Pi’s authenticated classifier inventory.',
        },
      ],
    }
  }

  return recommendSubagentModel(request, {
    configuration,
    candidateModels: inventory.candidateModels,
    classify: (classifierContext, options) => modelRegistry.classify(classifier, classifierContext, options),
    getSupportedThinkingLevels,
    clampThinkingLevel,
    signal,
  })
}

function resultText(result: RecommendationResult): string {
  if (result.status === 'recommended' || result.status === 'approval_required') {
    const { provider, model, thinking } = result.selection
    return `${result.status}: ${provider}/${model} (${thinking})`
  }
  if (result.status === 'classifier_failed') {
    return `${result.status}: ${result.category}`
  }
  return result.status
}

export function registerModelAdvisorTool(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  configuration: ConfigurationResult,
): void {
  pi.registerTool({
    name: RECOMMENDATION_TOOL_NAME,
    label: 'Recommend subagent model',
    description:
      'Recommend a Pi-eligible chat model for the explicit task state. This tool never changes the parent model or launches an agent. Classification may contact the configured native classifier.',
    parameters: RecommendationRequestSchema,
    outputSchema: RecommendationResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    execute: async (_toolCallId, request, signal, _onUpdate, context: ExtensionToolContext) => {
      const result = await recommendWithPi(request, configuration, context, signal)
      return {
        content: [{ type: 'text', text: resultText(result) }],
        details: result,
        structuredContent: result as unknown as JsonValue,
        ...('usage' in result && result.usage ? { usage: result.usage as Usage } : {}),
        ...(result.status === 'configuration_error' ||
        result.status === 'no_eligible_model' ||
        result.status === 'classifier_failed' ||
        result.status === 'aborted'
          ? { isError: true }
          : {}),
      }
    },
  })
}
