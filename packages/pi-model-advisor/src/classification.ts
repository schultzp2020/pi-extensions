import type { ClassifierContext, ClassifierResult, JsonValue } from '@earendil-works/pi-ai'

import { CAPABILITIES, THINKING_LEVELS, type AdvisorConfiguration, type ModelIdentity } from './config.ts'
import type { ClassifierAnswers, NativeUsage, RecommendationRequest, RecommendationResult } from './types.ts'

export interface ClassifierExecutionOptions {
  signal?: AbortSignal
}

export type ClassifierExecution = (
  context: ClassifierContext,
  options: ClassifierExecutionOptions,
) => Promise<ClassifierResult>

export type ClassificationOutcome =
  | { status: 'classified'; answers: ClassifierAnswers; usage?: NativeUsage }
  | Extract<RecommendationResult, { status: 'classifier_failed' | 'aborted' }>

const CAPABILITY_RUBRICS = {
  light: 'Routine, mechanical, or tightly bounded work.',
  standard: 'Ordinary localized work with multiple steps.',
  advanced: 'Complex cross-component work requiring substantial judgment.',
  frontier: 'Exceptionally difficult work with extensive uncertainty or constraints.',
} satisfies Record<(typeof CAPABILITIES)[number], string>

const THINKING_RUBRICS = {
  off: 'Direct lookup, transcription, or mechanical action.',
  minimal: 'A straightforward single-step judgment.',
  low: 'Localized work with a few dependencies.',
  medium: 'Multi-step reasoning across related components.',
  high: 'Difficult diagnosis, design, or competing constraints.',
  xhigh: 'Extensive ambiguity and many interacting constraints.',
  max: 'Exceptionally demanding sustained reasoning.',
} satisfies Record<(typeof THINKING_LEVELS)[number], string>

const CONTEXT_RUBRICS = {
  narrow: 'One localized artifact.',
  moderate: 'Several related artifacts.',
  broad: 'Cross-module or repository-wide dependencies.',
  exceptional: 'Extensive cross-system material.',
}

const INVALID_ANSWER_MESSAGE = 'Classifier returned invalid answers.'
const TRANSPORT_ERROR_MESSAGE = 'Classifier request failed.'
const DEADLINE_MESSAGE = 'Classifier deadline exceeded.'

function taskState(request: RecommendationRequest, configuration: AdvisorConfiguration): Record<string, JsonValue> {
  const state: Record<string, JsonValue> = { task: request.task }
  if (request.taskKind !== undefined) {
    const profile = configuration.tasks[request.taskKind]
    const levels = Array.isArray(profile) ? profile : profile.levels
    state.taskProfile = {
      name: request.taskKind,
      levels,
      ...(!Array.isArray(profile) && profile.description !== undefined ? { description: profile.description } : {}),
    }
  }
  if (request.role !== undefined) {
    state.role = request.role
  }
  if (request.context !== undefined) {
    state.context = request.context
  }
  if (request.requirements !== undefined) {
    state.requirements = request.requirements
  }
  if (request.levels !== undefined) {
    state.levels = request.levels
  }
  return state
}

export function createClassifierContext(
  request: RecommendationRequest,
  configuration: AdvisorConfiguration,
): ClassifierContext {
  return {
    state: taskState(request, configuration),
    questions: {
      required_capability: {
        type: 'choice',
        instructions: 'What minimum model capability is required to complete the explicit task reliably?',
        criteria: CAPABILITY_RUBRICS,
      },
      reasoning_effort: {
        type: 'choice',
        instructions: 'What Pi thinking level best matches the reasoning effort required by the explicit task?',
        criteria: THINKING_RUBRICS,
      },
      context_demand: {
        type: 'choice',
        instructions: 'How broad is the information context required to complete the explicit task?',
        criteria: CONTEXT_RUBRICS,
      },
      high_consequence: {
        type: 'bool',
        instructions:
          'Could an incorrect result cause material security, data, release, migration, or operational harm?',
        criteria: {
          true: 'Yes; an incorrect result could cause material harm.',
          false: 'No; an incorrect result is unlikely to cause material harm.',
        },
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function validatedChoice(
  value: unknown,
  labels: readonly string[],
): { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['type', 'choice', 'probabilities', 'confidence'])) {
    return undefined
  }
  if (value.type !== 'choice' || typeof value.choice !== 'string' || !labels.includes(value.choice)) {
    return undefined
  }
  if (!validProbability(value.confidence) || !isRecord(value.probabilities)) {
    return undefined
  }
  if (!hasExactlyKeys(value.probabilities, labels)) {
    return undefined
  }
  const probabilities: Record<string, number> = {}
  let total = 0
  for (const label of labels) {
    const probability = value.probabilities[label]
    if (!validProbability(probability)) {
      return undefined
    }
    probabilities[label] = probability
    total += probability
  }
  if (Math.abs(total - 1) > 0.0001) {
    return undefined
  }
  for (const label of labels) {
    probabilities[label] /= total
  }
  return { type: 'choice', choice: value.choice, probabilities, confidence: value.confidence }
}

function validateAnswers(value: unknown): ClassifierAnswers | undefined {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['required_capability', 'reasoning_effort', 'context_demand', 'high_consequence'])
  ) {
    return undefined
  }
  const capability = validatedChoice(value.required_capability, CAPABILITIES)
  const effort = validatedChoice(value.reasoning_effort, THINKING_LEVELS)
  const context = validatedChoice(value.context_demand, ['narrow', 'moderate', 'broad', 'exceptional'])
  const consequence = value.high_consequence
  if (!capability || !effort || !context || !isRecord(consequence)) {
    return undefined
  }
  if (!hasExactlyKeys(consequence, ['type', 'probability']) || consequence.type !== 'bool') {
    return undefined
  }
  if (!validProbability(consequence.probability)) {
    return undefined
  }
  return {
    required_capability: capability as ClassifierAnswers['required_capability'],
    reasoning_effort: effort as ClassifierAnswers['reasoning_effort'],
    context_demand: context as ClassifierAnswers['context_demand'],
    high_consequence: { type: 'bool', probability: consequence.probability },
  }
}

function classifierFailure(
  classifier: ModelIdentity,
  category: 'transport' | 'deadline' | 'invalid_answer',
  message: string,
  usage?: NativeUsage,
): ClassificationOutcome {
  return { status: 'classifier_failed', classifier, category, message, ...(usage ? { usage } : {}) }
}

function aborted(classifier: ModelIdentity, usage?: NativeUsage): ClassificationOutcome {
  return { status: 'aborted', classifier, ...(usage ? { usage } : {}) }
}

export async function classifyRecommendation(input: {
  request: RecommendationRequest
  configuration: AdvisorConfiguration
  classify: ClassifierExecution
  signal?: AbortSignal
}): Promise<ClassificationOutcome> {
  const { request, configuration, classify, signal } = input
  const { classifier } = configuration
  if (signal?.aborted) {
    return aborted(classifier)
  }

  const controller = new AbortController()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let resolveCallerAbort: () => void = () => undefined
  const callerAbort = new Promise<{ kind: 'caller_abort' }>((resolve) => {
    resolveCallerAbort = () => resolve({ kind: 'caller_abort' })
  })
  const handleAbort = () => {
    controller.abort(signal?.reason)
    resolveCallerAbort()
  }
  signal?.addEventListener('abort', handleAbort, { once: true })
  const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error(DEADLINE_MESSAGE))
      resolve({ kind: 'deadline' })
    }, configuration.policy.overallDeadlineMs)
  })
  const nativeRequest = Promise.resolve()
    .then(() => classify(createClassifierContext(request, configuration), { signal: controller.signal }))
    .then(
      (result) => ({ kind: 'response' as const, result }),
      () => ({ kind: 'transport_error' as const }),
    )

  try {
    const outcome = await Promise.race([nativeRequest, deadline, callerAbort])
    if (signal?.aborted || outcome.kind === 'caller_abort') {
      const usage = outcome.kind === 'response' ? (outcome.result.usage as NativeUsage | undefined) : undefined
      return aborted(classifier, usage)
    }
    if (outcome.kind === 'deadline') {
      return classifierFailure(classifier, 'deadline', DEADLINE_MESSAGE)
    }
    if (outcome.kind === 'transport_error') {
      return classifierFailure(classifier, 'transport', TRANSPORT_ERROR_MESSAGE)
    }

    const { result } = outcome
    const usage = result.usage as NativeUsage | undefined
    if (result.stopReason === 'aborted') {
      return aborted(classifier, usage)
    }
    if (result.stopReason === 'error') {
      return classifierFailure(classifier, 'transport', TRANSPORT_ERROR_MESSAGE, usage)
    }
    if (result.provider !== classifier.provider || result.model !== classifier.model) {
      return classifierFailure(classifier, 'invalid_answer', INVALID_ANSWER_MESSAGE, usage)
    }
    const answers = validateAnswers(result.answers)
    return answers
      ? { status: 'classified', answers, ...(usage ? { usage } : {}) }
      : classifierFailure(classifier, 'invalid_answer', INVALID_ANSWER_MESSAGE, usage)
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer)
    }
    signal?.removeEventListener('abort', handleAbort)
  }
}
