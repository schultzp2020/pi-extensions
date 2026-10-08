import type { ClassifierContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import { recommendWithPi, type RecommendationContext } from './adapter.ts'
import { runClassifierWithDeadline, type ClassifierExecution } from './classification.ts'
import {
  discoverAdvisorModels,
  type AdvisorModelInventory,
  type ConfigurationResult,
  type ModelIdentity,
} from './config.ts'
import type { RecommendationRequest, RecommendationResult } from './types.ts'

export interface ModelAdvisorCommandOptions {
  configuration: ConfigurationResult
  recommend?: typeof recommendWithPi
  recordRecommendation?: (
    request: RecommendationRequest,
    result: RecommendationResult,
    context: RecommendationContext,
  ) => void
}

const RELOAD_BOUNDARY = 'Configuration edits apply only after extension initialization or Pi /reload.'
const PRIVACY_BOUNDARY =
  'Privacy: explicit task state is sent to the configured Pi classifier and may leave this machine; advisor logs omit it by default, while Pi may independently retain command/tool arguments and session transcripts.'
const USAGE =
  'Usage: /model-advisor [status|models|config|doctor [--connectivity]|recommend <task>]. Configuration edits apply only after extension initialization or Pi /reload.'
type ConnectivityProbeResult =
  | { status: 'responded' }
  | { status: 'classifier_failed'; category: 'transport' | 'deadline' | 'invalid_answer' }
  | { status: 'aborted' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function probeClassifier(
  classifier: ModelIdentity,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  classify: ClassifierExecution,
): Promise<ConnectivityProbeResult> {
  if (signal?.aborted) {
    return { status: 'aborted' }
  }

  const context: ClassifierContext = {
    state: { probe: 'model-advisor-connectivity' },
    questions: {
      connectivity: {
        type: 'bool',
        instructions: 'Can the configured native classifier process this connectivity check?',
        criteria: { true: 'The connectivity probe is valid.', false: 'The connectivity probe is not valid.' },
      },
    },
  }
  const outcome = await runClassifierWithDeadline({ context, classify, deadlineMs, signal })
  if (signal?.aborted || outcome.kind === 'caller_abort') {
    return { status: 'aborted' }
  }
  if (outcome.kind === 'deadline') {
    return { status: 'classifier_failed', category: 'deadline' }
  }
  if (outcome.kind === 'transport_error') {
    return { status: 'classifier_failed', category: 'transport' }
  }

  const { result } = outcome
  if (result.stopReason === 'aborted') {
    return { status: 'aborted' }
  }
  if (result.stopReason === 'error' || result.errorMessage !== undefined) {
    return { status: 'classifier_failed', category: 'transport' }
  }
  if (result.provider !== classifier.provider || result.model !== classifier.model) {
    return { status: 'classifier_failed', category: 'invalid_answer' }
  }
  const answers: unknown = result.answers
  if (!isRecord(answers) || Object.keys(answers).length !== 1 || !isRecord(answers.connectivity)) {
    return { status: 'classifier_failed', category: 'invalid_answer' }
  }
  const answer = answers.connectivity
  if (
    Object.keys(answer).length !== 2 ||
    answer.type !== 'bool' ||
    typeof answer.probability !== 'number' ||
    !Number.isFinite(answer.probability) ||
    answer.probability < 0 ||
    answer.probability > 1
  ) {
    return { status: 'classifier_failed', category: 'invalid_answer' }
  }
  return { status: 'responded' }
}

function formatIdentities(identities: readonly ModelIdentity[]): string {
  return identities.length > 0 ? identities.map(({ provider, model }) => `${provider}/${model}`).join(', ') : 'none'
}

function formatIssues(result: ConfigurationResult | AdvisorModelInventory): string[] {
  if (result.status !== 'configuration_error') {
    return []
  }
  return result.issues.map(({ path, code, message }) => `${JSON.stringify(path)}: ${code}: ${message}`)
}

async function discoverInventory(ctx: ExtensionCommandContext, configuration: ConfigurationResult) {
  return discoverAdvisorModels(configuration, ctx.modelRegistry, ctx.scopedModels)
}

function inventoryLines(
  inventory: AdvisorModelInventory,
  mode: 'status' | 'models' | 'doctor',
  connectivityRequested: boolean,
): string[] {
  const lines = [
    `Configuration: ${inventory.status}`,
    `Classifier: ${inventory.classifier.status}`,
    `Chat models: ${inventory.eligible.length} eligible, ${inventory.unclassified.length} unclassified, ${inventory.unavailable.length} unavailable, ${inventory.rejected.length} outside Pi scope.`,
    `Invalid model limits: ${
      inventory.invalidLimits.length > 0
        ? inventory.invalidLimits
            .map(({ provider, model, reasons }) => `${provider}/${model} (${reasons.join(', ')})`)
            .join(', ')
        : 'none'
    }.`,
  ]
  if (mode === 'models') {
    lines.push(
      `Eligible: ${formatIdentities(inventory.eligible)}`,
      `Unclassified: ${formatIdentities(inventory.unclassified)}`,
      `Unavailable: ${formatIdentities(inventory.unavailable)}`,
      `Outside Pi scope: ${formatIdentities(inventory.rejected)}`,
    )
  }
  lines.push(...formatIssues({ status: 'configuration_error', issues: inventory.issues }))
  if (connectivityRequested) {
    lines.push('Classifier connectivity probe explicitly requested.')
  } else {
    lines.push('No classifier inference was made.')
  }
  lines.push(RELOAD_BOUNDARY)
  return lines
}

function connectivityStatus(result: ConnectivityProbeResult): {
  message: string
  level: 'info' | 'error'
} {
  if (result.status === 'responded') {
    return { message: 'Connectivity probe: classifier responded.', level: 'info' }
  }
  if (result.status === 'classifier_failed') {
    return { message: `Connectivity probe: classifier_failed (${result.category}).`, level: 'error' }
  }
  return { message: 'Connectivity probe: aborted.', level: 'error' }
}

export function registerModelAdvisorCommands(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: ModelAdvisorCommandOptions,
): void {
  const { configuration } = options
  const recommend = options.recommend ?? recommendWithPi

  pi.registerCommand('model-advisor', {
    description: 'Inspect Pi Model Advisor configuration and model eligibility',
    handler: async (args, ctx) => {
      const input = args.trim()
      const [command = 'status', ...arguments_] = input.split(/\s+/).filter(Boolean)
      switch (command) {
        case 'config': {
          if (arguments_.length > 0) {
            ctx.ui.notify(USAGE, 'info')
            return
          }
          const lines = ['Source: Pi global agent directory; project configuration is ignored.', RELOAD_BOUNDARY]
          if (configuration.status !== 'valid') {
            lines.push('Configuration: configuration_error', ...formatIssues(configuration), PRIVACY_BOUNDARY)
            ctx.ui.notify(lines.join('\n'), 'error')
            return
          }

          const inventory = await discoverInventory(ctx, configuration)
          lines.push(
            `Configuration: ${inventory.status}`,
            `Classifier: ${inventory.classifier.status}`,
            ...formatIssues(inventory),
            `Active configuration snapshot:\n${JSON.stringify(configuration.configuration, null, 2)}`,
            PRIVACY_BOUNDARY,
          )
          ctx.ui.notify(lines.join('\n'), inventory.status === 'configuration_error' ? 'error' : 'info')
          return
        }
        case 'doctor':
        case 'models':
        case 'status': {
          const connectivityRequested =
            command === 'doctor' && arguments_.length === 1 && arguments_[0] === '--connectivity'
          if (arguments_.length > 0 && !connectivityRequested) {
            ctx.ui.notify(USAGE, 'info')
            return
          }
          const inventory = await discoverInventory(ctx, configuration)
          const lines = [...inventoryLines(inventory, command, connectivityRequested), PRIVACY_BOUNDARY]
          ctx.ui.notify(lines.join('\n'), inventory.status === 'configuration_error' ? 'error' : 'info')
          if (!connectivityRequested) {
            return
          }
          if (inventory.status === 'configuration_error') {
            ctx.ui.notify('Connectivity probe skipped: configuration or classifier is unavailable.', 'error')
            return
          }
          if (configuration.status !== 'valid') {
            ctx.ui.notify('Connectivity probe skipped: configuration is invalid.', 'error')
            return
          }
          const classifier = ctx.modelRegistry.getModelOfType(
            'classifier',
            configuration.configuration.classifier.provider,
            configuration.configuration.classifier.model,
          )
          if (!classifier) {
            ctx.ui.notify('Connectivity probe skipped: configured classifier is unavailable.', 'error')
            return
          }
          const result = await probeClassifier(
            configuration.configuration.classifier,
            configuration.configuration.policy.overallDeadlineMs,
            ctx.signal,
            (classifierContext, classifyOptions) =>
              ctx.modelRegistry.classify(classifier, classifierContext, classifyOptions),
          )
          const probe = connectivityStatus(result)
          ctx.ui.notify(`${probe.message}\n${RELOAD_BOUNDARY}\n${PRIVACY_BOUNDARY}`, probe.level)
          return
        }
        case 'recommend': {
          const task = input.slice(command.length).trim()
          if (!task) {
            ctx.ui.notify(`Usage: /model-advisor recommend <task>\n${RELOAD_BOUNDARY}`, 'info')
            return
          }
          const request = { task } satisfies RecommendationRequest
          const result = await recommend(request, configuration, ctx)
          options.recordRecommendation?.(request, result, ctx)
          const level = result.status === 'recommended' || result.status === 'approval_required' ? 'info' : 'error'
          ctx.ui.notify(`${JSON.stringify(result, null, 2)}\n${RELOAD_BOUNDARY}\n${PRIVACY_BOUNDARY}`, level)
          return
        }
        default: {
          ctx.ui.notify(USAGE, 'info')
        }
      }
    },
  })
}
