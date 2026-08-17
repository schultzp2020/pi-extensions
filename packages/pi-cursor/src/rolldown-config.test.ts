import { fileURLToPath } from 'node:url'

import { build, type OutputChunk } from 'rolldown'
import { loadConfig } from 'rolldown/config'
import { describe, expect, it } from 'vitest'

describe('published extension bundle', () => {
  it('bundles legacy lazy streaming while preserving host adapter dispatch', async () => {
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
    const dynamicImports = chunks.flatMap((chunk) => chunk.dynamicImports)
    const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds.map((id) => id.replaceAll('\\', '/')))
    const indexEntry = chunks.find((chunk) => chunk.isEntry && chunk.fileName === 'index.js')
    const proxyEntry = chunks.find((chunk) => chunk.isEntry && chunk.fileName === 'proxy/main.js')

    expect(imports).not.toContain('@earendil-works/pi-ai/api/lazy')
    expect(imports).not.toContain('@earendil-works/pi-ai/api/openai-completions')
    expect(imports).toContain('@earendil-works/pi-ai')
    expect(dynamicImports).toContain('@earendil-works/pi-ai/compat')
    expect(moduleIds.some((id) => id.endsWith('/dist/api/lazy.js'))).toBe(true)
    expect(moduleIds.some((id) => id.endsWith('/dist/api/openai-completions.js'))).toBe(false)
    expect(indexEntry?.moduleIds.some((id) => id.replaceAll('\\', '/').endsWith('/src/proxy-lifecycle.ts'))).toBe(true)
    expect(proxyEntry?.moduleIds.some((id) => id.replaceAll('\\', '/').endsWith('/src/proxy-lifecycle.ts'))).toBe(false)
  })
})
