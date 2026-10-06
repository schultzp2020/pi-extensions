import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Api, Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  discoverAdvisorModels,
  loadAdvisorConfiguration,
  validateAdvisorConfiguration,
  type AdvisorModelRegistry,
} from './config.ts'

let originalAgentDir: string | undefined
let originalCwd: string | undefined
let testAgentDir: string | undefined

afterEach(async () => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir
  }
  if (originalCwd) {
    process.chdir(originalCwd)
  }
  if (testAgentDir) {
    await rm(testAgentDir, { recursive: true, force: true })
  }
  testAgentDir = undefined
})

async function useAgentDir(): Promise<string> {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR
  testAgentDir = await mkdtemp(join(tmpdir(), 'pi-model-advisor-test-'))
  process.env.PI_CODING_AGENT_DIR = testAgentDir
  return testAgentDir
}

function configuration() {
  return {
    classifier: { provider: 'openrouter', model: 'typesafe/jev-1.13' },
    models: {
      light: [
        { provider: 'openai', model: 'gpt-luna', thinking: { minimum: 'max', maximum: 'max' } },
        { provider: 'openai-codex', model: 'gpt-luna', thinking: { minimum: 'max', maximum: 'max' } },
      ],
    },
  }
}

function chatModel(provider: string, id: string, api = 'openai-completions'): Model<Api> {
  return {
    provider,
    id,
    api,
    name: id,
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 4_000,
    input: ['text'],
  } as Model<Api>
}

describe('loadAdvisorConfiguration', () => {
  it('uses Pi’s global agent directory and fails closed for missing or malformed files', async () => {
    const agentDir = await useAgentDir()
    const projectDir = join(agentDir, 'project')
    const projectPiDir = join(projectDir, '.pi')
    await mkdir(projectPiDir, { recursive: true })
    await writeFile(join(projectPiDir, 'model-advisor.json'), '{ invalid project overlay')
    originalCwd = process.cwd()
    process.chdir(projectDir)

    const missing = await loadAdvisorConfiguration()
    expect(missing).toEqual({
      status: 'configuration_error',
      issues: [{ path: '', code: 'file_missing', message: 'Configuration file does not exist.' }],
    })

    await writeFile(join(agentDir, 'model-advisor.json'), JSON.stringify(configuration()))
    const loaded = await loadAdvisorConfiguration()
    expect(loaded.status).toBe('valid')

    await writeFile(join(agentDir, 'model-advisor.json'), '{ invalid global configuration')
    expect(await loadAdvisorConfiguration()).toEqual({
      status: 'configuration_error',
      issues: [{ path: '', code: 'invalid_json', message: 'Configuration file contains invalid JSON.' }],
    })
  })
})

describe('discoverAdvisorModels', () => {
  it('uses nonempty Pi scope, excludes virtual models, and keeps classifier discovery separate', async () => {
    const allAvailable = [
      { ...chatModel('openai', 'gpt-luna'), reasoning: true, thinkingLevelMap: { max: 'max' } },
      chatModel('openai-codex', 'gpt-sol'),
      chatModel('openai', 'gpt-unclassified'),
      chatModel('router', 'auto', 'pi-virtual'),
    ]
    const inScope = [allAvailable[0], allAvailable[2], allAvailable[3]]
    const getAvailableOfType = vi.fn<(type: string) => Promise<{ provider: string; id: string }[]>>(() =>
      Promise.resolve([{ provider: 'openrouter', id: 'typesafe/jev-1.13' }]),
    )
    const classify = vi.fn<() => void>()
    const registry = {
      getAvailable: () => allAvailable,
      getAvailableOfType,
      classify,
    } as unknown as AdvisorModelRegistry
    const result = await discoverAdvisorModels(
      validateAdvisorConfiguration({
        classifier: { provider: 'openrouter', model: 'typesafe/jev-1.13' },
        models: {
          light: [{ provider: 'openai', model: 'gpt-luna', thinking: { minimum: 'max', maximum: 'max' } }],
          standard: [{ provider: 'openai-codex', model: 'gpt-sol' }],
          frontier: [{ provider: 'openai', model: 'gpt-missing' }],
        },
      }),
      registry,
      inScope.map((model) => ({ model })),
    )

    expect(result.status).toBe('ready')
    expect(result.classifier).toEqual({
      status: 'available',
      identity: { provider: 'openrouter', model: 'typesafe/jev-1.13' },
    })
    expect(result.eligible).toEqual([{ provider: 'openai', model: 'gpt-luna' }])
    expect(result.unclassified).toEqual([{ provider: 'openai', model: 'gpt-unclassified' }])
    expect(result.unavailable).toEqual([{ provider: 'openai', model: 'gpt-missing' }])
    expect(result.rejected).toEqual([{ provider: 'openai-codex', model: 'gpt-sol' }])
    expect(result.candidateModels.map(({ id }) => id)).toEqual(['gpt-luna', 'gpt-unclassified'])
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('classifier')
    expect(classify).not.toHaveBeenCalled()
  })

  it('accepts an exact native local classifier from Pi’s classifier inventory', async () => {
    const getAvailableOfType = vi.fn<(type: string) => Promise<{ provider: string; id: string }[]>>(() =>
      Promise.resolve([{ provider: 'llama.cpp', id: 'local-clef-id' }]),
    )
    const classify = vi.fn<() => void>()
    const registry = {
      getAvailable: () => [],
      getAvailableOfType,
      classify,
    } as unknown as AdvisorModelRegistry
    const result = await discoverAdvisorModels(
      validateAdvisorConfiguration({
        classifier: { provider: 'llama.cpp', model: 'local-clef-id' },
        models: {},
      }),
      registry,
      [],
    )

    expect(result.status).toBe('ready')
    expect(result.classifier).toEqual({
      status: 'available',
      identity: { provider: 'llama.cpp', model: 'local-clef-id' },
    })
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('classifier')
    expect(classify).not.toHaveBeenCalled()
  })

  it('reports a missing exact classifier and unsupported configured thinking without making inference calls', async () => {
    const model = chatModel('openai', 'gpt-luna')
    const getAvailableOfType = vi.fn<(type: string) => Promise<{ provider: string; id: string }[]>>(() =>
      Promise.resolve([{ provider: 'openrouter', id: 'different-classifier' }]),
    )
    const classify = vi.fn<() => void>()
    const registry = {
      getAvailable: () => [model],
      getAvailableOfType,
      classify,
    } as unknown as AdvisorModelRegistry
    const result = await discoverAdvisorModels(
      validateAdvisorConfiguration({
        classifier: { provider: 'llama.cpp', model: 'local-clef-id' },
        models: { light: [{ provider: 'openai', model: 'gpt-luna', thinking: { minimum: 'max', maximum: 'max' } }] },
      }),
      registry,
      [],
    )

    expect(result.status).toBe('configuration_error')
    expect(result.classifier).toEqual({
      status: 'unavailable',
      identity: { provider: 'llama.cpp', model: 'local-clef-id' },
    })
    expect(
      result.issues.some(({ path, code }) => path === '/classifier' && code === 'classifier_unavailable'),
    ).toBeTruthy()
    expect(
      result.issues.some(({ path, code }) => path === '/models/light/0/thinking' && code === 'unsupported_thinking'),
    ).toBeTruthy()
    expect(result.eligible).toEqual([])
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('classifier')
    expect(classify).not.toHaveBeenCalled()
  })
})

describe('validateAdvisorConfiguration', () => {
  it('applies the approved global defaults', () => {
    expect(
      validateAdvisorConfiguration({
        classifier: { provider: 'llama.cpp', model: 'local-classifier' },
        models: {},
      }),
    ).toEqual({
      status: 'valid',
      configuration: {
        classifier: { provider: 'llama.cpp', model: 'local-classifier' },
        models: {},
        tasks: {},
        thinking: { minimum: 'off', maximum: 'max' },
        policy: {
          capabilityPercentile: 75,
          consequenceThresholds: { advanced: 0.7, frontier: 0.9 },
          overallDeadlineMs: 60_000,
        },
        logging: { includeTask: false },
      },
    })
  })

  it('rejects nonfinite policy numbers', () => {
    for (const capabilityPercentile of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = validateAdvisorConfiguration({
        classifier: { provider: 'llama.cpp', model: 'local-classifier' },
        models: {},
        policy: { capabilityPercentile },
      })

      expect(result.status).toBe('configuration_error')
      if (result.status !== 'configuration_error') {
        throw new Error('Expected invalid configuration')
      }
      expect(
        result.issues.some(({ path, code }) => path === '/policy/capabilityPercentile' && code === 'schema_invalid'),
      ).toBeTruthy()
    }
  })

  it('validates task profiles with multiline names', () => {
    const taskName = 'custom\nreview'
    const result = validateAdvisorConfiguration({
      ...configuration(),
      tasks: { [taskName]: 42 },
    })

    expect(result.status).toBe('configuration_error')
    if (result.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      result.issues.some(({ path, code }) => path === `/tasks/${taskName}` && code === 'schema_invalid'),
    ).toBeTruthy()
  })

  it('escapes slashes and tildes in configuration issue paths', () => {
    const invalidRootKey = validateAdvisorConfiguration({ ...configuration(), 'unknown/key~name': true })
    const invalidTaskProfile = validateAdvisorConfiguration({
      ...configuration(),
      tasks: { 'custom/key~name': 42 },
    })
    const invalidNestedTaskProfile = validateAdvisorConfiguration({
      ...configuration(),
      tasks: { 'custom/key~name': { levels: ['light'], 'unknown/key~name': true } },
    })

    expect(invalidRootKey.status).toBe('configuration_error')
    if (invalidRootKey.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      invalidRootKey.issues.some(({ path, code }) => path === '/unknown~1key~0name' && code === 'schema_invalid'),
    ).toBeTruthy()
    expect(invalidTaskProfile.status).toBe('configuration_error')
    if (invalidTaskProfile.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      invalidTaskProfile.issues.some(
        ({ path, code }) => path === '/tasks/custom~1key~0name' && code === 'schema_invalid',
      ),
    ).toBeTruthy()
    expect(invalidNestedTaskProfile.status).toBe('configuration_error')
    if (invalidNestedTaskProfile.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      invalidNestedTaskProfile.issues.some(
        ({ path, code }) => path === '/tasks/custom~1key~0name/unknown~1key~0name' && code === 'schema_invalid',
      ),
    ).toBeTruthy()
  })

  it('rejects unknown top-level settings with their exact configuration path', () => {
    const result = validateAdvisorConfiguration({ ...configuration(), endpoint: 'https://example.invalid' })

    expect(result.status).toBe('configuration_error')
    if (result.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(result.issues.some(({ path, code }) => path === '/endpoint' && code === 'schema_invalid')).toBeTruthy()
  })

  it('rejects unknown model settings with their exact configuration path', () => {
    const value = configuration()
    const result = validateAdvisorConfiguration({
      ...value,
      models: { light: [{ ...value.models.light[0], enabled: true }] },
    })

    expect(result.status).toBe('configuration_error')
    if (result.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      result.issues.some(({ path, code }) => path === '/models/light/0/enabled' && code === 'schema_invalid'),
    ).toBeTruthy()
  })

  it('rejects repeated provider/model identities across capability groups', () => {
    const value = configuration()
    const duplicate = { ...value.models.light[0] }

    const result = validateAdvisorConfiguration({
      ...value,
      models: { ...value.models, frontier: [duplicate] },
    })

    expect(result.status).toBe('configuration_error')
    if (result.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      result.issues.some(({ path, code }) => path === '/models/frontier/0' && code === 'duplicate_model'),
    ).toBeTruthy()
  })

  it('rejects inverted configured thinking ranges and consequence thresholds', () => {
    const value = configuration()
    const invertedThinking = validateAdvisorConfiguration({
      ...value,
      thinking: { minimum: 'high', maximum: 'low' },
    })
    const invertedThresholds = validateAdvisorConfiguration({
      ...value,
      policy: { consequenceThresholds: { advanced: 0.95, frontier: 0.9 } },
    })

    expect(invertedThinking.status).toBe('configuration_error')
    if (invertedThinking.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      invertedThinking.issues.some(({ path, code }) => path === '/thinking' && code === 'invalid_range'),
    ).toBeTruthy()
    expect(invertedThresholds.status).toBe('configuration_error')
    if (invertedThresholds.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(
      invertedThresholds.issues.some(
        ({ path, code }) => path === '/policy/consequenceThresholds' && code === 'invalid_range',
      ),
    ).toBeTruthy()
  })

  it('accepts arbitrary task names with array and described-object profiles', () => {
    const result = validateAdvisorConfiguration({
      ...configuration(),
      tasks: {
        implement: ['light'],
        custom_security_review: {
          description: 'Audit authentication changes for privilege escalation.',
          levels: ['advanced', 'frontier'],
        },
      },
    })

    expect(result.status).toBe('valid')
    if (result.status !== 'valid') {
      throw new Error('Expected valid configuration')
    }
    expect(result.configuration.tasks).toEqual({
      implement: ['light'],
      custom_security_review: {
        description: 'Audit authentication changes for privilege escalation.',
        levels: ['advanced', 'frontier'],
      },
    })
  })

  it('rejects whitespace-only task names at their exact configuration path', () => {
    const value = configuration()
    const result = validateAdvisorConfiguration({ ...value, tasks: { '  ': ['light'] } })

    expect(result.status).toBe('configuration_error')
    if (result.status !== 'configuration_error') {
      throw new Error('Expected invalid configuration')
    }
    expect(result.issues.some(({ path, code }) => path === '/tasks/  ' && code === 'schema_invalid')).toBeTruthy()
  })
})
