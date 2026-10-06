import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import { recommendWithPi, registerModelAdvisorTool } from './adapter.ts'
import {
  discoverAdvisorModels,
  loadAdvisorConfiguration,
  type ConfigurationResult,
  type ModelIdentity,
} from './config.ts'
import type { RecommendationRequest } from './types.ts'

export interface ModelAdvisorExtensionOptions {
  loadConfiguration?: () => Promise<ConfigurationResult>
}

function formatIdentities(identities: readonly ModelIdentity[]): string {
  return identities.length > 0 ? identities.map(({ provider, model }) => `${provider}/${model}`).join(', ') : 'none'
}

function formatIssues(result: ConfigurationResult): string[] {
  if (result.status !== 'configuration_error') {
    return []
  }
  return result.issues.map(({ path, code, message }) => `${JSON.stringify(path)}: ${code}: ${message}`)
}

function notifyInventory(
  ctx: ExtensionCommandContext,
  result: ConfigurationResult,
  mode: 'status' | 'models' | 'doctor',
): Promise<void> {
  return discoverAdvisorModels(result, ctx.modelRegistry, ctx.scopedModels).then((inventory) => {
    const lines = [
      `Configuration: ${inventory.status}`,
      `Classifier: ${inventory.classifier.status}`,
      `Chat models: ${inventory.eligible.length} eligible, ${inventory.unclassified.length} unclassified, ${inventory.unavailable.length} unavailable, ${inventory.rejected.length} outside Pi scope.`,
    ]
    if (mode === 'models') {
      lines.push(
        `Eligible: ${formatIdentities(inventory.eligible)}`,
        `Unclassified: ${formatIdentities(inventory.unclassified)}`,
        `Unavailable: ${formatIdentities(inventory.unavailable)}`,
        `Outside Pi scope: ${formatIdentities(inventory.rejected)}`,
      )
    }
    lines.push(
      ...formatIssues({ status: 'configuration_error', issues: inventory.issues }),
      'No classifier inference was made.',
      'Configuration edits apply only after extension initialization or Pi /reload.',
    )
    ctx.ui.notify(lines.join('\n'), inventory.status === 'configuration_error' ? 'error' : 'info')
  })
}

async function notifyConfiguration(ctx: ExtensionCommandContext, result: ConfigurationResult): Promise<void> {
  const lines = [
    'Source: Pi global agent directory; project configuration is ignored.',
    'Reload boundary: configuration loads at extension initialization and Pi /reload only.',
  ]
  if (result.status !== 'valid') {
    lines.push('Configuration: configuration_error', ...formatIssues(result))
    ctx.ui.notify(lines.join('\n'), 'error')
    return
  }

  const inventory = await discoverAdvisorModels(result, ctx.modelRegistry, ctx.scopedModels)
  lines.push(
    `Configuration: ${inventory.status}`,
    `Classifier: ${inventory.classifier.status}`,
    ...formatIssues({ status: 'configuration_error', issues: inventory.issues }),
    `Active configuration snapshot:\n${JSON.stringify(result.configuration, null, 2)}`,
  )
  ctx.ui.notify(lines.join('\n'), inventory.status === 'configuration_error' ? 'error' : 'info')
}

export async function registerModelAdvisorExtension(
  pi: Pick<ExtensionAPI, 'registerCommand' | 'registerTool'>,
  options: ModelAdvisorExtensionOptions = {},
): Promise<void> {
  const configuration = await (options.loadConfiguration ?? loadAdvisorConfiguration)()
  registerModelAdvisorTool(pi, configuration)

  pi.registerCommand('model-advisor', {
    description: 'Inspect Pi Model Advisor configuration and model eligibility',
    handler: async (args, ctx) => {
      const command = args.trim().split(/\s+/, 1)[0] || 'status'
      switch (command) {
        case 'config': {
          await notifyConfiguration(ctx, configuration)
          return
        }
        case 'doctor':
        case 'models':
        case 'status': {
          await notifyInventory(ctx, configuration, command)
          return
        }
        case 'recommend': {
          const task = args.trim().slice(command.length).trim()
          if (!task) {
            ctx.ui.notify('Usage: /model-advisor recommend <task>', 'info')
            return
          }
          const result = await recommendWithPi({ task } satisfies RecommendationRequest, configuration, ctx)
          ctx.ui.notify(
            JSON.stringify(result, null, 2),
            result.status === 'recommended' || result.status === 'approval_required' ? 'info' : 'error',
          )
          return
        }
        default: {
          ctx.ui.notify(
            'Usage: /model-advisor [status|models|config|doctor|recommend <task>]. Configuration edits apply after Pi /reload.',
            'info',
          )
        }
      }
    },
  })
}

export default function (pi: ExtensionAPI): Promise<void> {
  return registerModelAdvisorExtension(pi)
}
