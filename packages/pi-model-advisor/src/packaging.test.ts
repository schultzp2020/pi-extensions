import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

vi.mock('pi-subagents', () => {
  throw new Error('The default extension/core entry points must not import pi-subagents.')
})
vi.mock('pi-subagents/preflight', () => {
  throw new Error('The default extension/core entry points must not import the optional preflight entry.')
})
const packageDirectory = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  files: string[]
  type: string
  types?: string
  exports: Record<string, { types?: string; import?: string }>
  pi: { extensions: string[] }
  scripts: { build: string; prepublishOnly?: string }
  dependencies?: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

describe('published package contents', () => {
  it('ships its README and MIT license with the built distribution', () => {
    expect(packageJson.files).toEqual(expect.arrayContaining(['dist/', 'README.md', 'LICENSE']))
    expect(existsSync(`${packageDirectory}/README.md`)).toBeTruthy()
    expect(existsSync(`${packageDirectory}/LICENSE`)).toBeTruthy()
  })

  it('links the contract from the published README without relying on unpackaged repository files', () => {
    const packageReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(packageReadme).toContain(
      'https://github.com/schultzp2020/pi-extensions/blob/main/docs/pi-model-advisor.openapi.yaml',
    )
  })

  it('documents native llama.cpp ownership and requirements', () => {
    const packageReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(packageJson.pi.extensions).toEqual(['./dist/index.js'])
    expect(packageReadme).toContain('Pi 1.1.0')
    expect(packageReadme).toContain('llama.cpp 0.6.0')
    expect(packageReadme).toContain("Use Pi's built-in `llama.cpp` provider.")
    expect(packageReadme).toContain('ChatGPT/Codex login')
    expect(packageReadme).toContain('architecture.output_modalities')
    for (const dependency of [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
    ]) {
      expect(packageJson.devDependencies[dependency]).toBe('1.1.0')
      expect(packageJson.peerDependencies[dependency]).toBe('>=1.1.0')
    }
  })

  it('documents current setup without obsolete upgrade instructions', () => {
    for (const path of ['../README.md', '../../../README.md', '../../../docs/pi-1.1.0.md']) {
      const content = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(content).not.toMatch(/upgrad|migrat|llama-cpp-provider|1\.0\.4/iu)
    }
    expect(existsSync(new URL('../../../docs/pi-1.1.0-migration.md', import.meta.url))).toBeFalsy()
  })

  it('lists the public package in the monorepo package table', () => {
    const rootReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    expect(rootReadme).toMatch(/^\| \[pi-model-advisor\]\(packages\/pi-model-advisor\/\) \|/m)
  })

  it('maps only the supported ESM entry points and excludes the removed provider entry', () => {
    expect(packageJson).toMatchObject({
      type: 'module',
      types: './dist/index.d.ts',
      pi: { extensions: ['./dist/index.js'] },
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './core': { types: './dist/core.d.ts', import: './dist/core.js' },
        './pi-subagents': { types: './dist/pi-subagents.d.ts', import: './dist/pi-subagents.js' },
      },
    })
    expect(packageJson.exports).not.toHaveProperty('./llama-cpp-provider')
    expect(existsSync(`${packageDirectory}/src/llama-cpp-provider.ts`)).toBeFalsy()
  })

  it('builds only the extension, reusable core, and optional handoff entries', () => {
    const buildConfig = readFileSync(new URL('../rolldown.config.ts', import.meta.url), 'utf8')
    expect(buildConfig).toContain("index: 'src/index.ts'")
    expect(buildConfig).toContain("core: 'src/core.ts'")
    expect(buildConfig).toContain("'pi-subagents': 'src/pi-subagents.ts'")
    expect(buildConfig).not.toContain('llama-cpp-provider')
    expect(packageJson.scripts.build).toMatch(/^node .*rmSync\('dist'/u)
  })

  it('runs the package build from the publish lifecycle hook', () => {
    expect(packageJson.scripts.prepublishOnly).toBe('pnpm run build')
  })

  it('emits importable declaration files through the dedicated build configuration', () => {
    const buildConfig = JSON.parse(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8')) as {
      compilerOptions: Record<string, unknown>
      exclude: string[]
    }

    expect(packageJson.scripts.build).toContain('tsconfig.build.json')
    expect(buildConfig.compilerOptions).toMatchObject({
      noEmit: false,
      emitDeclarationOnly: true,
    })
    expect(buildConfig.exclude).toEqual(expect.arrayContaining(['src/**/*.test.ts', 'src/test-fixtures.ts']))
  })

  it('keeps pi-subagents available for published-contract tests but out of package runtime imports', async () => {
    expect(packageJson.devDependencies['pi-subagents']).toBe('0.76.1')
    expect(packageJson.dependencies?.['pi-subagents']).toBeUndefined()

    const [extension, core, handoff] = await Promise.all([
      import('./index.ts'),
      import('./core.ts'),
      import('./pi-subagents.ts'),
    ])
    expect(extension.registerModelAdvisorExtension).toBeTypeOf('function')
    expect(core.recommendSubagentModel).toBeTypeOf('function')
    expect(handoff.verifySubagentRecommendation).toBeTypeOf('function')
  })
})
