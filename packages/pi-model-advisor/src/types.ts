import { Type, type Static } from 'typebox'

import { type ConfigurationIssue, type ConfigurationIssueCode } from './config.ts'
import { CAPABILITIES, THINKING_LEVELS } from './config.ts'

const NonemptyStringSchema = Type.String({ minLength: 1, pattern: '\\S' })
const CapabilitySchema = Type.Union([
  Type.Literal(CAPABILITIES[0]),
  Type.Literal(CAPABILITIES[1]),
  Type.Literal(CAPABILITIES[2]),
  Type.Literal(CAPABILITIES[3]),
])
const ThinkingLevelSchema = Type.Union([
  Type.Literal(THINKING_LEVELS[0]),
  Type.Literal(THINKING_LEVELS[1]),
  Type.Literal(THINKING_LEVELS[2]),
  Type.Literal(THINKING_LEVELS[3]),
  Type.Literal(THINKING_LEVELS[4]),
  Type.Literal(THINKING_LEVELS[5]),
  Type.Literal(THINKING_LEVELS[6]),
])
const ContextDemandSchema = Type.Union([
  Type.Literal('narrow'),
  Type.Literal('moderate'),
  Type.Literal('broad'),
  Type.Literal('exceptional'),
])
const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 })

export const RecommendationRequestSchema = Type.Object(
  {
    task: NonemptyStringSchema,
    taskKind: Type.Optional(NonemptyStringSchema),
    role: Type.Optional(NonemptyStringSchema),
    context: Type.Optional(Type.String()),
    requirements: Type.Optional(
      Type.Object(
        {
          imageInput: Type.Optional(Type.Boolean()),
          minimumContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
          allowedProviders: Type.Optional(Type.Array(NonemptyStringSchema, { uniqueItems: true })),
          minimumThinking: Type.Optional(ThinkingLevelSchema),
          maximumThinking: Type.Optional(ThinkingLevelSchema),
        },
        { additionalProperties: false },
      ),
    ),
    levels: Type.Optional(Type.Array(CapabilitySchema, { uniqueItems: true })),
  },
  { additionalProperties: false },
)
export type RecommendationRequest = Static<typeof RecommendationRequestSchema>

export const ModelIdentitySchema = Type.Object(
  {
    provider: NonemptyStringSchema,
    model: NonemptyStringSchema,
  },
  { additionalProperties: false },
)

export const SelectionSchema = Type.Object(
  {
    provider: NonemptyStringSchema,
    model: NonemptyStringSchema,
    thinking: ThinkingLevelSchema,
    capability: CapabilitySchema,
  },
  { additionalProperties: false },
)
export type Selection = Static<typeof SelectionSchema>

const CapabilityProbabilitiesSchema = Type.Object(
  { light: ProbabilitySchema, standard: ProbabilitySchema, advanced: ProbabilitySchema, frontier: ProbabilitySchema },
  { additionalProperties: false },
)
const ThinkingProbabilitiesSchema = Type.Object(
  {
    off: ProbabilitySchema,
    minimal: ProbabilitySchema,
    low: ProbabilitySchema,
    medium: ProbabilitySchema,
    high: ProbabilitySchema,
    xhigh: ProbabilitySchema,
    max: ProbabilitySchema,
  },
  { additionalProperties: false },
)
const ContextDemandProbabilitiesSchema = Type.Object(
  {
    narrow: ProbabilitySchema,
    moderate: ProbabilitySchema,
    broad: ProbabilitySchema,
    exceptional: ProbabilitySchema,
  },
  { additionalProperties: false },
)

export const ClassifierAnswersSchema = Type.Object(
  {
    required_capability: Type.Object(
      {
        type: Type.Literal('choice'),
        choice: CapabilitySchema,
        probabilities: CapabilityProbabilitiesSchema,
        confidence: ProbabilitySchema,
      },
      { additionalProperties: false },
    ),
    reasoning_effort: Type.Object(
      {
        type: Type.Literal('choice'),
        choice: ThinkingLevelSchema,
        probabilities: ThinkingProbabilitiesSchema,
        confidence: ProbabilitySchema,
      },
      { additionalProperties: false },
    ),
    context_demand: Type.Object(
      {
        type: Type.Literal('choice'),
        choice: ContextDemandSchema,
        probabilities: ContextDemandProbabilitiesSchema,
        confidence: ProbabilitySchema,
      },
      { additionalProperties: false },
    ),
    high_consequence: Type.Object(
      { type: Type.Literal('bool'), probability: ProbabilitySchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type ClassifierAnswers = Static<typeof ClassifierAnswersSchema>

export const PolicyDetailsSchema = Type.Object(
  {
    taskKind: Type.Optional(NonemptyStringSchema),
    allowedLevels: Type.Array(CapabilitySchema, { uniqueItems: true }),
    automaticLevels: Type.Array(CapabilitySchema, { uniqueItems: true }),
    capabilityPercentile: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
    baseCapability: CapabilitySchema,
    consequenceFloor: Type.Optional(CapabilitySchema),
    requiredCapability: CapabilitySchema,
    contextDemand: ContextDemandSchema,
    contextWindowPreference: Type.Boolean(),
    requestedThinking: ThinkingLevelSchema,
    permittedThinking: Type.Object(
      { minimum: ThinkingLevelSchema, maximum: ThinkingLevelSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type PolicyDetails = Static<typeof PolicyDetailsSchema>

const RejectionReasonSchema = Type.Union([
  Type.Literal('unavailable'),
  Type.Literal('virtual_model'),
  Type.Literal('unclassified'),
  Type.Literal('caller_level_excluded'),
  Type.Literal('provider_excluded'),
  Type.Literal('image_unsupported'),
  Type.Literal('context_insufficient'),
  Type.Literal('invalid_context_window'),
  Type.Literal('invalid_max_tokens'),
  Type.Literal('thinking_incompatible'),
  Type.Literal('capability_insufficient'),
  Type.Literal('task_blocked'),
  Type.Literal('outside_normal_pool'),
])
export type RejectionReason = Static<typeof RejectionReasonSchema>

export const RejectionSchema = Type.Object(
  {
    provider: NonemptyStringSchema,
    model: NonemptyStringSchema,
    reasons: Type.Array(RejectionReasonSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
)
export type Rejection = Static<typeof RejectionSchema>

const ConfigurationIssueCodeSchema = Type.Union([
  Type.Literal('file_missing'),
  Type.Literal('file_unreadable'),
  Type.Literal('invalid_json'),
  Type.Literal('schema_invalid'),
  Type.Literal('duplicate_model'),
  Type.Literal('invalid_range'),
  Type.Literal('unsupported_thinking'),
  Type.Literal('classifier_unavailable'),
])
export const ConfigurationIssueSchema = Type.Object(
  {
    path: Type.String(),
    code: ConfigurationIssueCodeSchema,
    message: Type.String(),
  },
  { additionalProperties: false },
)

export const NativeUsageSchema = Type.Object(
  {
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    totalTokens: Type.Number({ minimum: 0 }),
    cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
    cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
    cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
    reasoning: Type.Optional(Type.Number({ minimum: 0 })),
    cost: Type.Object(
      {
        input: Type.Optional(Type.Number({ minimum: 0 })),
        output: Type.Optional(Type.Number({ minimum: 0 })),
        cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
        cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
        total: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)
export type NativeUsage = Static<typeof NativeUsageSchema>

const UsageProperty = Type.Optional(NativeUsageSchema)
const ResultCommon = {
  classifier: ModelIdentitySchema,
  answers: ClassifierAnswersSchema,
  policy: PolicyDetailsSchema,
  rejections: Type.Array(RejectionSchema),
  usage: UsageProperty,
}

export const RecommendedSchema = Type.Object(
  {
    status: Type.Literal('recommended'),
    classifier: ResultCommon.classifier,
    selection: SelectionSchema,
    answers: ResultCommon.answers,
    policy: ResultCommon.policy,
    rejections: ResultCommon.rejections,
    usage: ResultCommon.usage,
  },
  { additionalProperties: false },
)

export const ApprovalRequiredSchema = Type.Object(
  {
    status: Type.Literal('approval_required'),
    classifier: ResultCommon.classifier,
    selection: SelectionSchema,
    answers: ResultCommon.answers,
    policy: ResultCommon.policy,
    rejections: ResultCommon.rejections,
    usage: ResultCommon.usage,
  },
  { additionalProperties: false },
)

export const ConfigurationErrorSchema = Type.Object(
  {
    status: Type.Literal('configuration_error'),
    issues: Type.Array(ConfigurationIssueSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
)

export const NoEligibleModelSchema = Type.Object(
  {
    status: Type.Literal('no_eligible_model'),
    classifier: ModelIdentitySchema,
    rejections: Type.Array(RejectionSchema),
    answers: Type.Optional(ClassifierAnswersSchema),
    usage: UsageProperty,
  },
  { additionalProperties: false },
)

export const ClassifierFailedSchema = Type.Object(
  {
    status: Type.Literal('classifier_failed'),
    classifier: ModelIdentitySchema,
    category: Type.Union([Type.Literal('transport'), Type.Literal('deadline'), Type.Literal('invalid_answer')]),
    message: Type.String(),
    usage: UsageProperty,
  },
  { additionalProperties: false },
)

export const AbortedSchema = Type.Object(
  {
    status: Type.Literal('aborted'),
    classifier: Type.Optional(ModelIdentitySchema),
    usage: UsageProperty,
  },
  { additionalProperties: false },
)

export const RecommendationResultSchema = Type.Union([
  RecommendedSchema,
  ApprovalRequiredSchema,
  ConfigurationErrorSchema,
  NoEligibleModelSchema,
  ClassifierFailedSchema,
  AbortedSchema,
])
export type RecommendationResult = Static<typeof RecommendationResultSchema>
export type { ConfigurationIssue, ConfigurationIssueCode }
export { CAPABILITIES, THINKING_LEVELS }
