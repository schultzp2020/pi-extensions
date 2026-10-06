import type { Api, ClassifierContext, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'

import { classifyRecommendation, type ClassifierExecution } from './classification.ts'
import { THINKING_LEVELS, type ConfigurationResult } from './config.ts'
import { prepareRecommendationSelection, selectRecommendation, type ThinkingHelpers } from './selection.ts'
import { RecommendationRequestSchema, type RecommendationRequest, type RecommendationResult } from './types.ts'

export interface RecommendationDependencies extends ThinkingHelpers {
  configuration: ConfigurationResult
  candidateModels: readonly Model<Api>[]
  classify: ClassifierExecution
  signal?: AbortSignal
}

function invalidRequestMessage(request: unknown): string {
  const [firstError] = Value.Errors(RecommendationRequestSchema, request)
  return `Invalid recommendation request at ${firstError.instancePath || '/'}: ${firstError.message}`
}

function validateRecommendationRequest(
  request: unknown,
  configuration: ConfigurationResult,
): asserts request is RecommendationRequest {
  if (!Value.Check(RecommendationRequestSchema, request)) {
    throw new TypeError(invalidRequestMessage(request))
  }
  if (request.requirements?.minimumThinking && request.requirements.maximumThinking) {
    const minimum = THINKING_LEVELS.indexOf(request.requirements.minimumThinking)
    const maximum = THINKING_LEVELS.indexOf(request.requirements.maximumThinking)
    if (minimum > maximum) {
      throw new TypeError('minimumThinking must not exceed maximumThinking.')
    }
  }
  if (
    configuration.status === 'valid' &&
    request.taskKind !== undefined &&
    !Object.hasOwn(configuration.configuration.tasks, request.taskKind)
  ) {
    throw new TypeError(`Unknown task profile: ${request.taskKind}`)
  }
}

export async function recommendSubagentModel(
  request: RecommendationRequest,
  dependencies: RecommendationDependencies,
): Promise<RecommendationResult> {
  const { configuration, candidateModels, signal } = dependencies
  validateRecommendationRequest(request, configuration)
  if (signal?.aborted) {
    return {
      status: 'aborted',
      ...(configuration.status === 'valid' ? { classifier: configuration.configuration.classifier } : {}),
    }
  }
  if (configuration.status === 'configuration_error') {
    return { status: 'configuration_error', issues: configuration.issues }
  }

  const thinking: ThinkingHelpers = {
    getSupportedThinkingLevels: (model: Model<Api>) => dependencies.getSupportedThinkingLevels(model),
    clampThinkingLevel: (model: Model<Api>, level: ModelThinkingLevel) => dependencies.clampThinkingLevel(model, level),
  }
  const preparation = prepareRecommendationSelection({
    request,
    configuration: configuration.configuration,
    candidateModels,
    thinking,
  })
  if (preparation.status === 'complete') {
    return preparation.result
  }

  const classified = await classifyRecommendation({
    request,
    configuration: configuration.configuration,
    classify: (context: ClassifierContext, options: { signal?: AbortSignal }) =>
      dependencies.classify(context, options),
    signal,
  })
  if (signal?.aborted) {
    return {
      status: 'aborted',
      classifier: configuration.configuration.classifier,
      ...('usage' in classified && classified.usage ? { usage: classified.usage } : {}),
    }
  }
  if (classified.status !== 'classified') {
    return classified
  }

  return selectRecommendation({
    prepared: preparation.prepared,
    answers: classified.answers,
    ...(classified.usage ? { usage: classified.usage } : {}),
    thinking,
  })
}

export {
  AbortedSchema,
  ApprovalRequiredSchema,
  ClassifierAnswersSchema,
  ClassifierFailedSchema,
  ConfigurationErrorSchema,
  ConfigurationIssueSchema,
  ModelIdentitySchema,
  NativeUsageSchema,
  NoEligibleModelSchema,
  PolicyDetailsSchema,
  RecommendationRequestSchema,
  RecommendationResultSchema,
  RejectionSchema,
  RecommendedSchema,
  SelectionSchema,
  type ClassifierAnswers,
  type NativeUsage,
  type PolicyDetails,
  type RecommendationRequest,
  type RecommendationResult,
  type Rejection,
  type RejectionReason,
  type Selection,
} from './types.ts'
export type { ClassifierExecution, ClassifierExecutionOptions, ClassificationOutcome } from './classification.ts'
export type { ThinkingHelpers } from './selection.ts'
export { AdvisorConfigurationSchema, validateAdvisorConfiguration } from './config.ts'
export {
  CAPABILITIES,
  THINKING_LEVELS,
  type AdvisorConfiguration,
  type Capability,
  type ConfigurationIssue,
  type ConfigurationResult,
  type ModelIdentity,
  type ThinkingLevel,
} from './config.ts'
