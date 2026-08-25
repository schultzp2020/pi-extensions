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
    const { output } = loadedConfig
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
      expect(moduleIds.some((id) => id.endsWith('/dist/api/lazy.js'))).toBeTruthy()
      expect(moduleIds.some((id) => id.endsWith('/dist/api/openai-completions.js'))).toBeFalsy()

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
const agentDir = join(process.env.HOME, '.pi', 'agent')
const portFilePath = join(agentDir, 'cursor-proxy.json')
const lifecycleFilePath = join(agentDir, 'cursor-proxy-lifecycle.json')
const waitFor = async (condition, message) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}
await extension({
  registerProvider(_name, provider) {
    providers.push(provider)
  },
  registerCommand() {},
  on(event, handler) {
    handlers.set(event, handler)
  },
})
const initialProvider = providers.at(-1)
const firstProxy = JSON.parse(readFileSync(portFilePath, 'utf8'))
process.kill(firstProxy.pid, 'SIGKILL')
await waitFor(
  () => providers.at(-1)?.baseUrl === 'http://localhost:0/v1',
  'Provider stayed pinned to the exited proxy',
)
const disconnectedProvider = providers.at(-1)
await waitFor(() => {
  try {
    return JSON.parse(readFileSync(lifecycleFilePath, 'utf8')).childPid === firstProxy.pid
  } catch {
    return false
  }
}, 'Exited proxy lifecycle was not persisted')

const model = {
  id: 'cursor-test',
  name: 'Cursor Test',
  provider: 'cursor',
  api: 'cursor-openai-completions',
  baseUrl: initialProvider.baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}
const stream = disconnectedProvider?.streamSimple?.(
  model,
  {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'prove the same request recovers', timestamp: Date.now() }],
    tools: [],
  },
  { apiKey: 'fresh-bundle-token' },
)
if (!stream) throw new Error('Cursor provider did not return a request stream')
const result = await stream.result()
const secondProxy = JSON.parse(readFileSync(portFilePath, 'utf8'))
await waitFor(() => {
  try {
    return JSON.parse(readFileSync(lifecycleFilePath, 'utf8')).restartOutcome === 'succeeded'
  } catch {
    return false
  }
}, 'Successful proxy restart was not persisted')
const lifecycleText = readFileSync(lifecycleFilePath, 'utf8')
const lifecycle = JSON.parse(lifecycleText)
const responseText = result.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
process.stdout.write(JSON.stringify({
  initial: { ...firstProxy, providerBaseUrl: initialProvider.baseUrl },
  afterExit: { providerBaseUrl: disconnectedProvider.baseUrl },
  replacement: { ...secondProxy, providerBaseUrl: providers.at(-1)?.baseUrl },
  response: { stopReason: result.stopReason, text: responseText },
  sameRequestRoutedToReplacement:
    responseText === 'served-by:' + String(secondProxy.pid) + ':' + String(secondProxy.port),
  lifecycle,
  lifecycleKeys: Object.keys(lifecycle).sort(),
  credentialsAbsentFromLifecycle:
    !lifecycleText.includes('bundle-token') &&
    !lifecycleText.includes('fresh-bundle-token') &&
    !lifecycleText.includes('prove the same request recovers'),
}))
await handlers.get('session_shutdown')?.()
try {
  process.kill(secondProxy.pid, 'SIGTERM')
} catch {}
`,
      )

      const execution = spawnSync(process.execPath, [harnessPath], {
        cwd: outputDir,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
        timeout: 15_000,
      })
      expect(execution.error).toBeUndefined()
      expect(execution.status).toBe(0)
      const parsedRecovery: unknown = JSON.parse(execution.stdout)
      const recovery = parsedRecovery as {
        initial: { port: number; pid: number; providerBaseUrl: string }
        afterExit: { providerBaseUrl: string }
        replacement: { port: number; pid: number; providerBaseUrl: string }
        response: { stopReason: string; text: string }
        sameRequestRoutedToReplacement: boolean
        lifecycle: Record<string, unknown>
        lifecycleKeys: string[]
        credentialsAbsentFromLifecycle: boolean
      }
      expect(recovery.initial.providerBaseUrl).toMatch(/^http:\/\/localhost:\d+\/v1$/)
      expect(recovery.replacement.providerBaseUrl).toMatch(/^http:\/\/localhost:\d+\/v1$/)
      expect(recovery).toMatchObject({
        afterExit: { providerBaseUrl: 'http://localhost:0/v1' },
        response: { stopReason: 'stop' },
        sameRequestRoutedToReplacement: true,
        lifecycle: {
          childPid: recovery.initial.pid,
          exitCode: null,
          exitSignal: 'SIGKILL',
          restartOutcome: 'succeeded',
        },
        credentialsAbsentFromLifecycle: true,
      })
      expect(recovery.replacement.pid).not.toBe(recovery.initial.pid)
      expect(recovery.replacement.providerBaseUrl).toBe(`http://localhost:${String(recovery.replacement.port)}/v1`)
      expect(recovery.response.text).toBe(
        `served-by:${String(recovery.replacement.pid)}:${String(recovery.replacement.port)}`,
      )
      expect(recovery.lifecycleKeys).toEqual(
        ['timestamp', 'generation', 'observation', 'childPid', 'exitCode', 'exitSignal', 'restartOutcome'].sort(),
      )
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
