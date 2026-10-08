import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerModelAdvisorTool } from './adapter.ts'
import type { recommendWithPi } from './adapter.ts'
import { registerModelAdvisorCommands } from './commands.ts'
import { type ConfigurationResult, loadAdvisorConfiguration } from './config.ts'
import { registerModelAdvisorObservability } from './observability.ts'

export interface ModelAdvisorExtensionOptions {
  loadConfiguration?: () => Promise<ConfigurationResult>
  recommend?: typeof recommendWithPi
}

export async function registerModelAdvisorExtension(
  pi: Pick<ExtensionAPI, 'registerCommand' | 'registerTool'> & Partial<Pick<ExtensionAPI, 'on' | 'appendEntry'>>,
  options: ModelAdvisorExtensionOptions = {},
): Promise<void> {
  const configuration = await (options.loadConfiguration ?? loadAdvisorConfiguration)()
  const recordRecommendation =
    pi.on && pi.appendEntry
      ? registerModelAdvisorObservability(pi as Pick<ExtensionAPI, 'on' | 'appendEntry'>, configuration)
      : undefined
  registerModelAdvisorTool(pi, configuration)
  registerModelAdvisorCommands(pi, {
    configuration,
    recommend: options.recommend,
    recordRecommendation,
  })
}

export default function (pi: ExtensionAPI): Promise<void> {
  return registerModelAdvisorExtension(pi)
}
