import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, type OutputChunk } from 'rolldown'
import { loadConfig } from 'rolldown/config'
import { describe, expect, it } from 'vitest'

describe('published extension bundle', () => {
  it('bundles legacy lazy streaming while preserving host adapter dispatch', async () => {
    const configPath = fileURLToPath(new URL('../rolldown.config.ts', import.meta.url))
    const packageDir = fileURLToPath(new URL('..', import.meta.url))
    const loadedConfig = await loadConfig(configPath)
    if (typeof loadedConfig === 'function' || Array.isArray(loadedConfig)) {
      throw new Error('Expected one Rolldown configuration and one output')
    }
    const output = loadedConfig.output
    if (Array.isArray(output)) {
      throw new Error('Expected one Rolldown configuration and one output')
    }
    const outputDir = mkdtempSync(join(packageDir, '.rolldown-runtime-'))
    const homeDir = join(outputDir, 'home')
    const agentDir = join(homeDir, '.pi', 'agent')

    try {
      const result = await build({ ...loadedConfig, output: { ...output, dir: outputDir }, write: true })
      const chunks = result.output.filter((output): output is OutputChunk => output.type === 'chunk')
      const imports = chunks.flatMap((chunk) => chunk.imports)
      const dynamicImports = chunks.flatMap((chunk) => chunk.dynamicImports)
      const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds.map((id) => id.replaceAll('\\', '/')))

      expect(imports).not.toContain('@earendil-works/pi-ai/api/lazy')
      expect(imports).not.toContain('@earendil-works/pi-ai/api/openai-completions')
      expect(imports).toContain('@earendil-works/pi-ai')
      expect(dynamicImports).toContain('@earendil-works/pi-ai/compat')
      expect(moduleIds.some((id) => id.endsWith('/dist/api/lazy.js'))).toBe(true)
      expect(moduleIds.some((id) => id.endsWith('/dist/api/openai-completions.js'))).toBe(false)

      mkdirSync(agentDir, { recursive: true })
      writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ cursor: { access: 'bundle-token' } }))
      writeFileSync(
        join(outputDir, 'proxy', 'main.js'),
        readFileSync(fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url)), 'utf8'),
      )
      const harnessPath = join(outputDir, 'harness.mjs')
      writeFileSync(
        harnessPath,
        `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import extension from './index.js'

const providers = []
const handlers = new Map()
await extension({
  registerProvider(_name, provider) {
    providers.push(provider)
  },
  registerCommand() {},
  on(event, handler) {
    handlers.set(event, handler)
  },
})
const provider = providers.at(-1)
process.stdout.write(JSON.stringify({ baseUrl: provider?.baseUrl }))
await handlers.get('session_shutdown')?.()
try {
  const proxy = JSON.parse(readFileSync(join(process.env.HOME, '.pi', 'agent', 'cursor-proxy.json'), 'utf8'))
  process.kill(proxy.pid, 'SIGTERM')
} catch {}
`,
      )

      const execution = spawnSync(process.execPath, [harnessPath], {
        cwd: outputDir,
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
        timeout: 15_000,
      })
      expect(execution.error).toBeUndefined()
      expect(execution.status, execution.stderr).toBe(0)
      expect(JSON.parse(execution.stdout)).toMatchObject({
        baseUrl: expect.stringMatching(/^http:\/\/localhost:\d+\/v1$/),
      })
      expect(JSON.parse(execution.stdout)).not.toMatchObject({ baseUrl: 'http://localhost:0/v1' })
    } finally {
      try {
        const proxy = JSON.parse(readFileSync(join(agentDir, 'cursor-proxy.json'), 'utf8')) as { pid?: unknown }
        if (typeof proxy.pid === 'number') {
          process.kill(proxy.pid, 'SIGKILL')
        }
      } catch {}
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
