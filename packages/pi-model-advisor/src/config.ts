import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import { getAgentDir, type ModelRegistry, type ScopedModel } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

export const CAPABILITIES = ['light', 'standard', 'advanced', 'frontier'] as const
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type Capability = (typeof CAPABILITIES)[number]
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface ModelIdentity {
  provider: string
  model: string
}

export interface ThinkingRange {
  minimum: ThinkingLevel
  maximum: ThinkingLevel
}

export interface ConfiguredModel extends ModelIdentity {
  priority: number
  thinking: ThinkingRange
}

export type TaskProfile = Capability[] | { description?: string; levels: Capability[] }

export interface AdvisorConfiguration {
  classifier: ModelIdentity
  models: Partial<Record<Capability, ConfiguredModel[]>>
  tasks: Record<string, TaskProfile>
  thinking: ThinkingRange
  policy: {
    capabilityPercentile: number
    consequenceThresholds: { advanced: number; frontier: number }
    overallDeadlineMs: number
  }
  logging: { includeTask: boolean }
}

export type ConfigurationIssueCode =
  | 'file_missing'
  | 'file_unreadable'
  | 'invalid_json'
  | 'schema_invalid'
  | 'duplicate_model'
  | 'invalid_range'
  | 'unsupported_thinking'
  | 'classifier_unavailable'

export interface ConfigurationIssue {
  path: string
  code: ConfigurationIssueCode
  message: string
}

export type ConfigurationResult =
  | { status: 'valid'; configuration: AdvisorConfiguration }
  | { status: 'configuration_error'; issues: ConfigurationIssue[] }

const CapabilitySchema = Type.Union(CAPABILITIES.map((capability) => Type.Literal(capability)))
const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))
const NonemptyStringSchema = Type.String({ minLength: 1, pattern: '\\S' })
const IdentitySchema = Type.Object(
  {
    provider: NonemptyStringSchema,
    model: NonemptyStringSchema,
  },
  { additionalProperties: false },
)
const PartialThinkingRangeSchema = Type.Object(
  {
    minimum: Type.Optional(ThinkingLevelSchema),
    maximum: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
)
const ConfiguredModelSchema = Type.Object(
  {
    provider: NonemptyStringSchema,
    model: NonemptyStringSchema,
    priority: Type.Optional(Type.Integer()),
    thinking: Type.Optional(PartialThinkingRangeSchema),
  },
  { additionalProperties: false },
)
const LevelsSchema = Type.Array(CapabilitySchema, { uniqueItems: true })
const TaskProfileSchema = Type.Object(
  {
    description: Type.Optional(NonemptyStringSchema),
    levels: LevelsSchema,
  },
  { additionalProperties: false },
)
const TaskProfilesSchema = Type.Record(
  Type.String({ pattern: '^[\\s\\S]*$' }),
  Type.Union([LevelsSchema, TaskProfileSchema]),
)
const PolicySchema = Type.Object(
  {
    capabilityPercentile: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    consequenceThresholds: Type.Optional(
      Type.Object(
        {
          advanced: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          frontier: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    overallDeadlineMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export const AdvisorConfigurationSchema = Type.Object(
  {
    classifier: IdentitySchema,
    models: Type.Object(
      {
        light: Type.Optional(Type.Array(ConfiguredModelSchema)),
        standard: Type.Optional(Type.Array(ConfiguredModelSchema)),
        advanced: Type.Optional(Type.Array(ConfiguredModelSchema)),
        frontier: Type.Optional(Type.Array(ConfiguredModelSchema)),
      },
      { additionalProperties: false },
    ),
    tasks: Type.Optional(TaskProfilesSchema),
    thinking: Type.Optional(PartialThinkingRangeSchema),
    policy: Type.Optional(PolicySchema),
    logging: Type.Optional(
      Type.Object({ includeTask: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)

const DEFAULT_THINKING: ThinkingRange = { minimum: 'off', maximum: 'max' }

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

function schemaIssues(
  errors: readonly ReturnType<typeof Value.Errors>[number][],
  pathPrefix = '',
): ConfigurationIssue[] {
  return errors.flatMap((error) => {
    if (error.keyword === 'additionalProperties') {
      return error.params.additionalProperties.map((property) => ({
        path: `${pathPrefix}${error.instancePath}/${escapePointerSegment(property)}`,
        code: 'schema_invalid',
        message: error.message,
      }))
    }
    if (error.keyword === 'boolean' && error.schemaPath.endsWith('/additionalProperties')) {
      return []
    }
    return [
      {
        path: `${pathPrefix}${error.instancePath}`,
        code: 'schema_invalid',
        message: error.message,
      },
    ]
  })
}

function taskProfileIssues(tasks: unknown): ConfigurationIssue[] {
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
    return []
  }

  return Object.entries(tasks).flatMap(([taskName, profile]) => {
    const schema = Array.isArray(profile) ? LevelsSchema : TaskProfileSchema
    const errors = [...Value.Errors(schema, profile)]
    return schemaIssues(errors, `/tasks/${escapePointerSegment(taskName)}`)
  })
}

function thinkingIndex(level: string): number {
  return THINKING_LEVELS.findIndex((candidate) => candidate === level)
}

function normalizeRange(range?: Partial<ThinkingRange>): ThinkingRange {
  return {
    minimum: range?.minimum ?? DEFAULT_THINKING.minimum,
    maximum: range?.maximum ?? DEFAULT_THINKING.maximum,
  }
}

interface RawConfiguredModel extends ModelIdentity {
  priority?: number
  thinking?: Partial<ThinkingRange>
}

interface RawAdvisorConfiguration {
  classifier: ModelIdentity
  models: Partial<Record<Capability, RawConfiguredModel[]>>
  tasks?: Record<string, TaskProfile>
  thinking?: Partial<ThinkingRange>
  policy?: {
    capabilityPercentile?: number
    consequenceThresholds?: { advanced?: number; frontier?: number }
    overallDeadlineMs?: number
  }
  logging?: { includeTask?: boolean }
}

function normalizeConfiguration(source: RawAdvisorConfiguration): AdvisorConfiguration {
  const models: Partial<Record<Capability, ConfiguredModel[]>> = {}
  for (const capability of CAPABILITIES) {
    const group = source.models[capability]
    if (group) {
      models[capability] = group.map((model) => ({
        ...model,
        priority: model.priority ?? 0,
        thinking: normalizeRange(model.thinking),
      }))
    }
  }

  return {
    classifier: source.classifier,
    models,
    tasks: source.tasks ?? {},
    thinking: normalizeRange(source.thinking),
    policy: {
      capabilityPercentile: source.policy?.capabilityPercentile ?? 75,
      consequenceThresholds: {
        advanced: source.policy?.consequenceThresholds?.advanced ?? 0.7,
        frontier: source.policy?.consequenceThresholds?.frontier ?? 0.9,
      },
      overallDeadlineMs: source.policy?.overallDeadlineMs ?? 60_000,
    },
    logging: { includeTask: source.logging?.includeTask ?? false },
  }
}

export function validateAdvisorConfiguration(value: unknown): ConfigurationResult {
  const allValidationErrors = [...Value.Errors(AdvisorConfigurationSchema, value)]
  const taskSchemaPrefix = '#/properties/tasks/patternProperties/'
  const validationErrors = allValidationErrors.filter((error) => !error.schemaPath.startsWith(taskSchemaPrefix))
  const schemaValidationIssues = schemaIssues(validationErrors)
  if (schemaValidationIssues.length > 0) {
    return { status: 'configuration_error', issues: schemaValidationIssues }
  }

  const source = value as RawAdvisorConfiguration
  const taskIssues = taskProfileIssues(source.tasks)
  if (taskIssues.length > 0) {
    return { status: 'configuration_error', issues: taskIssues }
  }
  const seenModels = new Set<string>()
  const semanticIssues: ConfigurationIssue[] = []
  const ranges: { path: string; range?: Partial<ThinkingRange> }[] = [{ path: '/thinking', range: source.thinking }]
  for (const capability of CAPABILITIES) {
    for (const [index, model] of (source.models[capability] ?? []).entries()) {
      const key = identityKey(model)
      if (seenModels.has(key)) {
        semanticIssues.push({
          path: `/models/${capability}/${index}`,
          code: 'duplicate_model',
          message: 'Model identity is repeated across capability groups.',
        })
      } else {
        seenModels.add(key)
      }
      ranges.push({ path: `/models/${capability}/${index}/thinking`, range: model.thinking })
    }
  }
  for (const { path, range } of ranges) {
    const minimum = thinkingIndex(range?.minimum ?? DEFAULT_THINKING.minimum)
    const maximum = thinkingIndex(range?.maximum ?? DEFAULT_THINKING.maximum)
    if (minimum > maximum) {
      semanticIssues.push({ path, code: 'invalid_range', message: 'Thinking minimum exceeds maximum.' })
    }
  }
  for (const taskName of Object.keys(source.tasks ?? {})) {
    if (!/\S/.test(taskName)) {
      semanticIssues.push({
        path: `/tasks/${escapePointerSegment(taskName)}`,
        code: 'schema_invalid',
        message: 'Task profile name must contain a non-whitespace character.',
      })
    }
  }
  const advanced = source.policy?.consequenceThresholds?.advanced ?? 0.7
  const frontier = source.policy?.consequenceThresholds?.frontier ?? 0.9
  if (advanced > frontier) {
    semanticIssues.push({
      path: '/policy/consequenceThresholds',
      code: 'invalid_range',
      message: 'Advanced consequence threshold must not exceed frontier threshold.',
    })
  }
  if (semanticIssues.length > 0) {
    return { status: 'configuration_error', issues: semanticIssues }
  }

  return { status: 'valid', configuration: normalizeConfiguration(source) }
}

export async function loadAdvisorConfiguration(): Promise<ConfigurationResult> {
  const filePath = join(getAgentDir(), 'model-advisor.json')
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    return {
      status: 'configuration_error',
      issues: [
        {
          path: '',
          code: code === 'ENOENT' ? 'file_missing' : 'file_unreadable',
          message: code === 'ENOENT' ? 'Configuration file does not exist.' : 'Configuration file could not be read.',
        },
      ],
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {
      status: 'configuration_error',
      issues: [{ path: '', code: 'invalid_json', message: 'Configuration file contains invalid JSON.' }],
    }
  }
  return validateAdvisorConfiguration(value)
}

export interface AdvisorModelInventory {
  status: 'ready' | 'configuration_error'
  issues: ConfigurationIssue[]
  classifier: { status: 'available' | 'unavailable' | 'not_configured'; identity?: ModelIdentity }
  eligible: ModelIdentity[]
  unclassified: ModelIdentity[]
  unavailable: ModelIdentity[]
  rejected: ModelIdentity[]
  candidateModels: Model<Api>[]
}

export type AdvisorModelRegistry = Pick<ModelRegistry, 'getAvailable' | 'getAvailableOfType'>

function identityKey(identity: ModelIdentity): string {
  return JSON.stringify([identity.provider, identity.model])
}

function modelIdentity(model: Pick<Model<Api>, 'provider' | 'id'>): ModelIdentity {
  return { provider: model.provider, model: model.id }
}

function configuredModels(
  configuration: AdvisorConfiguration,
): { identity: ModelIdentity; capability: Capability; path: string; thinking: ThinkingRange }[] {
  const result: { identity: ModelIdentity; capability: Capability; path: string; thinking: ThinkingRange }[] = []
  for (const capability of CAPABILITIES) {
    for (const [index, model] of (configuration.models[capability] ?? []).entries()) {
      result.push({
        identity: { provider: model.provider, model: model.model },
        capability,
        path: `/models/${capability}/${index}`,
        thinking: model.thinking,
      })
    }
  }
  return result
}

export async function discoverAdvisorModels(
  configurationResult: ConfigurationResult,
  registry: AdvisorModelRegistry,
  scopedModels: readonly ScopedModel[],
): Promise<AdvisorModelInventory> {
  const configuration = configurationResult.status === 'valid' ? configurationResult.configuration : undefined
  const issues = configurationResult.status === 'configuration_error' ? [...configurationResult.issues] : []
  const available = registry.getAvailable().filter((model) => model.api !== 'pi-virtual')
  const candidates = (scopedModels.length > 0 ? scopedModels.map(({ model }) => model) : available).filter(
    (model) => model.api !== 'pi-virtual',
  )
  const candidateKeys = new Set(candidates.map((model) => identityKey(modelIdentity(model))))
  const availableKeys = new Set(available.map((model) => identityKey(modelIdentity(model))))
  const configured = configuration ? configuredModels(configuration) : []
  const configuredKeys = new Set(configured.map(({ identity }) => identityKey(identity)))
  const unsupportedThinkingModels = new Set<string>()
  const classifierIdentity = configuration?.classifier
  let classifierAvailable = false
  if (configuration) {
    try {
      const classifiers = await registry.getAvailableOfType('classifier')
      classifierAvailable = classifiers.some(
        (model) => model.provider === configuration.classifier.provider && model.id === configuration.classifier.model,
      )
    } catch {
      classifierAvailable = false
    }
    if (!classifierAvailable) {
      issues.push({
        path: '/classifier',
        code: 'classifier_unavailable',
        message: 'Configured classifier is not available in Pi’s authenticated classifier inventory.',
      })
    }
  }

  if (configuration) {
    for (const model of configured) {
      const availableModel = available.find(
        (candidate) => identityKey(modelIdentity(candidate)) === identityKey(model.identity),
      )
      if (!availableModel) {
        continue
      }
      const supported = getSupportedThinkingLevels(availableModel)
      const low = thinkingIndex(configuration.thinking.minimum)
      const high = thinkingIndex(configuration.thinking.maximum)
      const modelLow = thinkingIndex(model.thinking.minimum)
      const modelHigh = thinkingIndex(model.thinking.maximum)
      const permitted = supported.some((level) => {
        const levelIndex = thinkingIndex(level)
        return levelIndex >= low && levelIndex <= high && levelIndex >= modelLow && levelIndex <= modelHigh
      })
      if (!permitted) {
        unsupportedThinkingModels.add(identityKey(model.identity))
        issues.push({
          path: `${model.path}/thinking`,
          code: 'unsupported_thinking',
          message: 'Configured thinking ranges contain no Pi-supported level for this model.',
        })
      }
    }
  }

  const eligible = candidates
    .filter((model) => {
      const key = identityKey(modelIdentity(model))
      return configuredKeys.has(key) && !unsupportedThinkingModels.has(key)
    })
    .map(modelIdentity)
  const unclassified = candidates
    .filter((model) => !configuredKeys.has(identityKey(modelIdentity(model))))
    .map(modelIdentity)
  const unavailable = configured
    .filter(({ identity }) => !availableKeys.has(identityKey(identity)))
    .map(({ identity }) => identity)
  const rejected = configured
    .filter(({ identity }) => availableKeys.has(identityKey(identity)) && !candidateKeys.has(identityKey(identity)))
    .map(({ identity }) => identity)

  return {
    status: issues.length > 0 ? 'configuration_error' : 'ready',
    issues,
    classifier: configuration
      ? {
          status: classifierAvailable ? 'available' : 'unavailable',
          identity: classifierIdentity,
        }
      : { status: 'not_configured' },
    eligible,
    unclassified,
    unavailable,
    rejected,
    candidateModels: candidates,
  }
}
