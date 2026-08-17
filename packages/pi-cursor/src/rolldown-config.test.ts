import { fileURLToPath } from 'node:url'

import { build, type OutputChunk } from 'rolldown'
import { loadConfig } from 'rolldown/config'
import { describe, expect, it } from 'vitest'

describe('published extension bundle', () => {
  it('bundles the OpenAI completions adapter required at runtime', async () => {
    const configPath = fileURLToPath(new URL('../rolldown.config.ts', import.meta.url))
    const loadedConfig = await loadConfig(configPath)
    if (typeof loadedConfig === 'function' || Array.isArray(loadedConfig)) {
      throw new Error('Expected one Rolldown configuration and one output')
    }
    const output = loadedConfig.output
    if (Array.isArray(output)) {
      throw new Error('Expected one Rolldown configuration and one output')
    }

    const result = await build({ ...loadedConfig, output, write: false })
    const chunks = result.output.filter((output): output is OutputChunk => output.type === 'chunk')
    const imports = chunks.flatMap((chunk) => chunk.imports)
    const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds.map((id) => id.replaceAll('\\', '/')))

    expect(imports).toContain('@earendil-works/pi-ai')
    expect(imports).not.toContain('@earendil-works/pi-ai/api/openai-completions')
    expect(moduleIds.some((id) => id.endsWith('/dist/api/openai-completions.js'))).toBe(true)
  })
})
