import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'

import {
  CAPABILITIES,
  THINKING_LEVELS,
  type AdvisorConfiguration,
  type Capability,
  type ConfiguredModel,
  type ModelIdentity,
  type ThinkingLevel,
} from './config.ts'
import type {
  ClassifierAnswers,
  ConfigurationIssue,
  NativeUsage,
  RecommendationRequest,
  RecommendationResult,
  Rejection,
  RejectionReason,
} from './types.ts'

export interface ThinkingHelpers {
  getSupportedThinkingLevels(model: Model<Api>): readonly ModelThinkingLevel[]
  clampThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel
}

export interface PreparationCandidate {
  model: Model<Api>
  identity: ModelIdentity
  capability: Capability
  configured: ConfiguredModel
  supportedThinking: ThinkingLevel[]
  minimumThinkingIndex: number
  maximumThinkingIndex: number
}

export interface PreparedSelection {
  request: RecommendationRequest
  configuration: AdvisorConfiguration
  candidates: PreparationCandidate[]
  allowedLevels: Capability[]
  automaticLevels: Capability[]
  profileLevels?: Capability[]
  rejections: Map<string, { identity: ModelIdentity; reasons: RejectionReason[] }>
  classifier: ModelIdentity
}

export type SelectionPreparation =
  | { status: 'ready'; prepared: PreparedSelection }
  | { status: 'complete'; result: RecommendationResult }

function identityKey(identity: ModelIdentity): string {
  return JSON.stringify([identity.provider, identity.model])
}

function modelIdentity(model: Pick<Model<Api>, 'provider' | 'id'>): ModelIdentity {
  return { provider: model.provider, model: model.id }
}

function thinkingIndex(level: string): number {
  return THINKING_LEVELS.findIndex((candidate) => candidate === level)
}

function configuredModels(
  configuration: AdvisorConfiguration,
): Map<string, { capability: Capability; model: ConfiguredModel }> {
  const configured = new Map<string, { capability: Capability; model: ConfiguredModel }>()
  for (const capability of CAPABILITIES) {
    for (const model of configuration.models[capability] ?? []) {
      configured.set(identityKey(model), { capability, model })
    }
  }
  return configured
}

function addRejection(
  rejections: PreparedSelection['rejections'],
  identity: ModelIdentity,
  reason: RejectionReason,
): void {
  const key = identityKey(identity)
  const entry = rejections.get(key) ?? { identity, reasons: [] }
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason)
  }
  rejections.set(key, entry)
}

function sortedRejections(rejections: PreparedSelection['rejections']): Rejection[] {
  return [...rejections.values()]
    .sort((left, right) => compareIdentity(left.identity, right.identity))
    .map(({ identity, reasons }) => ({ ...identity, reasons }))
}

function compareIdentity(left: ModelIdentity, right: ModelIdentity): number {
  if (left.provider !== right.provider) {
    return left.provider < right.provider ? -1 : 1
  }
  if (left.model !== right.model) {
    return left.model < right.model ? -1 : 1
  }
  return 0
}

function noEligibleModel(
  classifier: ModelIdentity,
  rejections: PreparedSelection['rejections'],
  answers?: ClassifierAnswers,
  usage?: NativeUsage,
): RecommendationResult {
  return {
    status: 'no_eligible_model',
    classifier,
    rejections: sortedRejections(rejections),
    ...(answers ? { answers } : {}),
    ...(usage ? { usage } : {}),
  }
}

function configurationError(issue: ConfigurationIssue): RecommendationResult {
  return { status: 'configuration_error', issues: [issue] }
}

function candidateCanBeUsed(
  capability: Capability,
  allowedLevels: readonly Capability[],
  profileLevels: readonly Capability[] | undefined,
): boolean {
  if (!allowedLevels.includes(capability)) {
    return false
  }
  if (!profileLevels) {
    return true
  }
  if (profileLevels.includes(capability)) {
    return true
  }
  if (profileLevels.length === 0) {
    return false
  }
  return CAPABILITIES.indexOf(capability) > Math.max(...profileLevels.map((level) => CAPABILITIES.indexOf(level)))
}

export function prepareRecommendationSelection(input: {
  request: RecommendationRequest
  configuration: AdvisorConfiguration
  candidateModels: readonly Model<Api>[]
  thinking: ThinkingHelpers
}): SelectionPreparation {
  const { request, configuration, candidateModels, thinking } = input
  const { classifier } = configuration
  const requestLevels = request.levels
  const allowedLevels = requestLevels
    ? CAPABILITIES.filter((level) => requestLevels.includes(level))
    : [...CAPABILITIES]
  const selectedProfile = request.taskKind === undefined ? undefined : configuration.tasks[request.taskKind]
  const profileLevels =
    selectedProfile === undefined
      ? undefined
      : Array.isArray(selectedProfile)
        ? selectedProfile
        : selectedProfile.levels
  const automaticLevels = profileLevels
    ? CAPABILITIES.filter((level) => profileLevels.includes(level) && allowedLevels.includes(level))
    : [...allowedLevels]
  const rejections: PreparedSelection['rejections'] = new Map()
  const configured = configuredModels(configuration)
  const candidateByIdentity = new Map<string, Model<Api>>()

  for (const model of candidateModels) {
    const identity = modelIdentity(model)
    const key = identityKey(identity)
    if (model.api === 'pi-virtual') {
      addRejection(rejections, identity, 'virtual_model')
      continue
    }
    if (!candidateByIdentity.has(key)) {
      candidateByIdentity.set(key, model)
    }
  }

  const blockedByEmptyLevels = request.levels?.length === 0 || profileLevels?.length === 0
  const candidates: PreparationCandidate[] = []
  for (const model of candidateByIdentity.values()) {
    const identity = modelIdentity(model)
    const configuredEntry = configured.get(identityKey(identity))
    if (!configuredEntry) {
      addRejection(rejections, identity, 'unclassified')
      continue
    }
    const { capability, model: configuredModel } = configuredEntry
    if (blockedByEmptyLevels) {
      addRejection(rejections, identity, 'task_blocked')
      continue
    }
    if (!allowedLevels.includes(capability)) {
      addRejection(rejections, identity, 'caller_level_excluded')
      continue
    }
    if (!candidateCanBeUsed(capability, allowedLevels, profileLevels)) {
      addRejection(rejections, identity, 'outside_normal_pool')
      continue
    }

    let eligible = true
    const { requirements } = request
    if (requirements?.allowedProviders && !requirements.allowedProviders.includes(model.provider)) {
      addRejection(rejections, identity, 'provider_excluded')
      eligible = false
    }
    if (requirements?.imageInput && !model.input.includes('image')) {
      addRejection(rejections, identity, 'image_unsupported')
      eligible = false
    }
    if (
      requirements?.minimumContextWindow !== undefined &&
      (!Number.isFinite(model.contextWindow) || model.contextWindow < requirements.minimumContextWindow)
    ) {
      addRejection(rejections, identity, 'context_insufficient')
      eligible = false
    }

    const supportedThinking = thinking
      .getSupportedThinkingLevels(model)
      .filter((level): level is ThinkingLevel => THINKING_LEVELS.includes(level))
      .sort((left, right) => thinkingIndex(left) - thinkingIndex(right))
    const minimumThinkingIndex = Math.max(
      thinkingIndex(configuration.thinking.minimum),
      thinkingIndex(configuredModel.thinking.minimum),
    )
    const maximumThinkingIndex = Math.min(
      thinkingIndex(configuration.thinking.maximum),
      thinkingIndex(configuredModel.thinking.maximum),
    )
    const configuredSupport = supportedThinking.filter((level) => {
      const index = thinkingIndex(level)
      return index >= minimumThinkingIndex && index <= maximumThinkingIndex
    })
    if (configuredSupport.length === 0) {
      const configuredIndex = Object.entries(configuration.models)
        .flatMap(([group, models]) => models.map((candidate, index) => ({ group, candidate, index })))
        .find(({ candidate }) => identityKey(candidate) === identityKey(identity))
      return {
        status: 'complete',
        result: configurationError({
          path: `/models/${configuredIndex?.group ?? capability}/${configuredIndex?.index ?? 0}/thinking`,
          code: 'unsupported_thinking',
          message: 'Configured thinking ranges contain no Pi-supported level for this model.',
        }),
      }
    }

    const minimumIndex = Math.max(minimumThinkingIndex, thinkingIndex(requirements?.minimumThinking ?? 'off'))
    const maximumIndex = Math.min(maximumThinkingIndex, thinkingIndex(requirements?.maximumThinking ?? 'max'))
    const requestSupport = configuredSupport.filter((level) => {
      const index = thinkingIndex(level)
      return index >= minimumIndex && index <= maximumIndex
    })
    if (minimumIndex > maximumIndex || requestSupport.length === 0) {
      addRejection(rejections, identity, 'thinking_incompatible')
      eligible = false
    }
    if (!eligible) {
      continue
    }

    candidates.push({
      model,
      identity,
      capability,
      configured: configuredModel,
      supportedThinking: requestSupport,
      minimumThinkingIndex: minimumIndex,
      maximumThinkingIndex: maximumIndex,
    })
  }

  if (candidates.length === 0) {
    return { status: 'complete', result: noEligibleModel(classifier, rejections) }
  }

  return {
    status: 'ready',
    prepared: {
      request,
      configuration,
      candidates,
      allowedLevels,
      automaticLevels,
      ...(profileLevels ? { profileLevels: [...profileLevels] } : {}),
      rejections,
      classifier,
    },
  }
}

function percentileCapability(answers: ClassifierAnswers, percentile: number): Capability {
  const { probabilities } = answers.required_capability
  if (percentile === 100) {
    return [...CAPABILITIES].reverse().find((capability) => probabilities[capability] > 0) ?? 'light'
  }
  let cumulative = 0
  for (const capability of CAPABILITIES) {
    cumulative += probabilities[capability]
    if (cumulative * 100 >= percentile) {
      return capability
    }
  }
  return 'frontier'
}

function resolveThinking(
  candidate: PreparationCandidate,
  requested: ThinkingLevel,
  thinking: ThinkingHelpers,
): ThinkingLevel {
  const requestedIndex = Math.max(
    candidate.minimumThinkingIndex,
    Math.min(candidate.maximumThinkingIndex, thinkingIndex(requested)),
  )
  const clampedRequest = THINKING_LEVELS[requestedIndex]
  const resolved = thinking.clampThinkingLevel(candidate.model, clampedRequest)
  if (candidate.supportedThinking.includes(resolved)) {
    return resolved
  }
  const resolvedIndex = thinkingIndex(resolved)
  if (resolvedIndex > candidate.maximumThinkingIndex) {
    return candidate.supportedThinking.at(-1) ?? candidate.supportedThinking[0]
  }
  return candidate.supportedThinking[0]
}

function contextWindowPreference(answers: ClassifierAnswers): boolean {
  return answers.context_demand.choice === 'broad' || answers.context_demand.choice === 'exceptional'
}

function price(model: Model<Api>, key: 'output' | 'input' | 'cacheRead'): number | undefined {
  const value = model.cost[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function comparePrice(left: Model<Api>, right: Model<Api>, key: 'output' | 'input' | 'cacheRead'): number {
  const leftPrice = price(left, key)
  const rightPrice = price(right, key)
  if (leftPrice === undefined) {
    return rightPrice === undefined ? 0 : 1
  }
  if (rightPrice === undefined) {
    return -1
  }
  return leftPrice - rightPrice
}

function compareContextWindow(left: Model<Api>, right: Model<Api>): number {
  const leftContextWindow = Number.isFinite(left.contextWindow) ? left.contextWindow : undefined
  const rightContextWindow = Number.isFinite(right.contextWindow) ? right.contextWindow : undefined
  if (leftContextWindow === undefined) {
    return rightContextWindow === undefined ? 0 : 1
  }
  if (rightContextWindow === undefined) {
    return -1
  }
  return rightContextWindow - leftContextWindow
}

function compareCandidates(left: PreparationCandidate, right: PreparationCandidate, preferContext: boolean): number {
  const capabilityDifference = CAPABILITIES.indexOf(left.capability) - CAPABILITIES.indexOf(right.capability)
  if (capabilityDifference !== 0) {
    return capabilityDifference
  }
  const priorityDifference = right.configured.priority - left.configured.priority
  if (priorityDifference !== 0) {
    return priorityDifference
  }
  if (preferContext) {
    const contextDifference = compareContextWindow(left.model, right.model)
    if (contextDifference !== 0) {
      return contextDifference
    }
  }
  for (const key of ['output', 'input', 'cacheRead'] as const) {
    const difference = comparePrice(left.model, right.model, key)
    if (difference !== 0) {
      return difference
    }
  }
  return compareIdentity(left.identity, right.identity)
}

function addInsufficientCapabilityRejections(prepared: PreparedSelection, requiredCapability: Capability): void {
  for (const candidate of prepared.candidates) {
    if (CAPABILITIES.indexOf(candidate.capability) < CAPABILITIES.indexOf(requiredCapability)) {
      addRejection(prepared.rejections, candidate.identity, 'capability_insufficient')
    }
  }
}

export function selectRecommendation(input: {
  prepared: PreparedSelection
  answers: ClassifierAnswers
  usage?: NativeUsage
  thinking: ThinkingHelpers
}): RecommendationResult {
  const { prepared, answers, usage, thinking } = input
  const { configuration, candidates, request, profileLevels } = prepared
  const { advanced, frontier } = configuration.policy.consequenceThresholds
  const consequenceProbability = answers.high_consequence.probability
  const consequenceFloor: Capability | undefined =
    consequenceProbability >= frontier ? 'frontier' : consequenceProbability >= advanced ? 'advanced' : undefined
  const baseCapability = percentileCapability(answers, configuration.policy.capabilityPercentile)
  const requiredCapability =
    consequenceFloor && CAPABILITIES.indexOf(consequenceFloor) > CAPABILITIES.indexOf(baseCapability)
      ? consequenceFloor
      : baseCapability
  const wantsContextPreference = contextWindowPreference(answers)
  const capabilitySufficient = candidates.filter(
    ({ capability }) => CAPABILITIES.indexOf(capability) >= CAPABILITIES.indexOf(requiredCapability),
  )
  const normalCandidates = capabilitySufficient.filter(
    ({ capability }) => !profileLevels || prepared.automaticLevels.includes(capability),
  )
  let status: 'recommended' | 'approval_required' = 'recommended'
  let pool = normalCandidates

  if (pool.length === 0 && profileLevels !== undefined && profileLevels.length > 0) {
    const profileCeiling = Math.max(...profileLevels.map((level) => CAPABILITIES.indexOf(level)))
    pool = capabilitySufficient.filter(({ capability }) => CAPABILITIES.indexOf(capability) > profileCeiling)
    if (pool.length > 0) {
      status = 'approval_required'
    }
  }

  addInsufficientCapabilityRejections(prepared, requiredCapability)
  if (pool.length === 0) {
    return noEligibleModel(prepared.classifier, prepared.rejections, answers, usage)
  }

  pool.sort((left, right) => compareCandidates(left, right, wantsContextPreference))
  const [selected] = pool
  const requestedThinking = answers.reasoning_effort.choice
  const permittedThinking = {
    minimum: THINKING_LEVELS[selected.minimumThinkingIndex],
    maximum: THINKING_LEVELS[selected.maximumThinkingIndex],
  }
  const policy = {
    ...(request.taskKind !== undefined ? { taskKind: request.taskKind } : {}),
    allowedLevels: prepared.allowedLevels,
    automaticLevels: prepared.automaticLevels,
    capabilityPercentile: configuration.policy.capabilityPercentile,
    baseCapability,
    ...(consequenceFloor ? { consequenceFloor } : {}),
    requiredCapability,
    contextDemand: answers.context_demand.choice,
    contextWindowPreference: wantsContextPreference,
    requestedThinking,
    permittedThinking,
  }

  return {
    status,
    classifier: prepared.classifier,
    selection: {
      provider: selected.model.provider,
      model: selected.model.id,
      thinking: resolveThinking(selected, requestedThinking, thinking),
      capability: selected.capability,
    },
    answers,
    policy,
    rejections: sortedRejections(prepared.rejections),
    ...(usage ? { usage } : {}),
  }
}
