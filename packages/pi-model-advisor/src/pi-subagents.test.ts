import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSubagentLaunchContract } from 'pi-subagents/preflight'
import { describe, expect, it, vi } from 'vitest'

import type { RecommendationResult, Selection } from './core.ts'
import { verifySubagentRecommendation } from './pi-subagents.ts'

const selection: Selection = {
  provider: 'openai-codex',
  model: 'gpt-6-luna',
  thinking: 'max',
  capability: 'light',
}

const recommendation = {
  status: 'approval_required',
  selection,
} as RecommendationResult

type TestPreflightResult =
  | {
      ok: true
      contract: {
        model: string | undefined
        thinking: string
        diagnostics: unknown[]
        tools: { mcp: unknown[] }
      }
    }
  | { ok: false; code: string; message: string; diagnostics: unknown[] }
type TestResolver = (input: Parameters<typeof resolveSubagentLaunchContract>[0]) => Promise<TestPreflightResult>

describe('verifySubagentRecommendation', () => {
  it('verifies the exact provider/model/thinking without approving an approval-required proposal', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [],
          tools: { mcp: [] },
        },
      }),
    )
    const host = {
      parentModel: { provider: 'openai', id: 'gpt-6-sol' },
      scopedModelIds: ['openai-codex/gpt-6-luna'],
      availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
    }
    const launch = {
      agent: 'worker',
      task: 'Implement the requested subtask.',
      cwd: process.cwd(),
      context: 'fresh' as const,
      sessionRoot: '/tmp/pi-model-advisor-session',
    }

    const result = await verifySubagentRecommendation({
      recommendation,
      launch,
      host,
      resolveSubagentLaunchContract: resolve,
    })

    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      ...launch,
      ...host,
      model: 'openai-codex/gpt-6-luna:max',
    })
    expect(result).toEqual({ status: 'verified', selection })
    expect(recommendation.status).toBe('approval_required')
  })

  it('returns the recommendation snapshot captured before awaiting preflight', async () => {
    const mutableSelection = { ...selection }
    const mutableRecommendation = {
      status: 'approval_required',
      selection: mutableSelection,
    } as RecommendationResult
    let resolvePreflight!: (result: TestPreflightResult) => void
    const preflight = new Promise<TestPreflightResult>((resolve) => {
      resolvePreflight = resolve
    })
    const resolve = vi.fn<TestResolver>(() => preflight)
    const verification = verifySubagentRecommendation({
      recommendation: mutableRecommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    mutableSelection.provider = 'openai'
    resolvePreflight({
      ok: true,
      contract: {
        model: 'openai-codex/gpt-6-luna:max',
        thinking: 'max',
        diagnostics: [],
        tools: { mcp: [] },
      },
    })

    expect(resolve.mock.calls[0]?.[0].model).toBe('openai-codex/gpt-6-luna:max')
    expect(await verification).toEqual({ status: 'verified', selection })
  })

  it.each([
    { field: 'provider', model: 'openai/gpt-6-luna:max', thinking: 'max' },
    { field: 'model', model: 'openai-codex/gpt-6-sol:max', thinking: 'max' },
    { field: 'thinking', model: 'openai-codex/gpt-6-luna:low', thinking: 'low' },
  ])('rejects a preflight-adjusted $field without substitution', async ({ model, thinking }) => {
    const resolve = vi.fn<TestResolver>((_input) =>
      Promise.resolve({
        ok: true as const,
        contract: { model, thinking, diagnostics: [], tools: { mcp: [] } },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toMatchObject({
      status: 'verification_failed',
      category: 'selection_conflict',
    })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: 'openai-codex/gpt-6-luna:max' }))
  })

  it('does not forward a top-level thinking override from caller launch inputs', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: { model: input.model, thinking: 'max', diagnostics: [], tools: { mcp: [] } },
      }),
    )
    const launch = {
      agent: 'worker',
      task: 'Implement the requested subtask.',
      cwd: process.cwd(),
      thinking: 'low',
    }

    const result = await verifySubagentRecommendation({
      recommendation,
      launch,
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({ status: 'verified', selection })
    expect(resolve.mock.calls[0]?.[0]).not.toHaveProperty('thinking')
  })

  it('matches the published pi-subagents preflight contract for a native Pi child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-model-advisor-preflight-'))
    const project = join(root, 'project')
    const agentDirectory = join(project, '.pi', 'agents')
    const agentDataDirectory = join(root, 'agent-data')
    mkdirSync(agentDirectory, { recursive: true })
    mkdirSync(agentDataDirectory)
    writeFileSync(
      join(agentDirectory, 'worker.md'),
      '---\nname: worker\ndescription: test worker\n---\nComplete the assigned task.\n',
    )
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDataDirectory)

    try {
      const result = await verifySubagentRecommendation({
        recommendation,
        launch: {
          agent: 'worker',
          task: 'Implement the requested subtask.',
          cwd: project,
          context: 'fresh',
          sessionRoot: join(root, 'sessions'),
        },
        host: {
          parentModel: { provider: 'openai', id: 'gpt-6-sol' },
          scopedModelIds: ['openai-codex/gpt-6-luna'],
          availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna', fullId: 'openai-codex/gpt-6-luna' }],
        },
        resolveSubagentLaunchContract,
      })

      expect(result).toEqual({ status: 'verified', selection })

      const collidingHost = {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna', fullId: 'openai-codex/gpt-6-luna' }],
        thinkingCeiling: undefined,
      }
      const constrained = await verifySubagentRecommendation({
        recommendation,
        launch: {
          agent: 'worker',
          task: 'Implement the requested subtask.',
          cwd: project,
          context: 'fresh',
          sessionRoot: join(root, 'sessions'),
          thinkingCeiling: 'low',
        },
        host: collidingHost,
        resolveSubagentLaunchContract,
      })
      expect(constrained).toMatchObject({
        status: 'verification_failed',
        category: 'preflight_rejected',
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns a structured preflight rejection without retrying or substituting a model', async () => {
    const resolve = vi.fn<TestResolver>(() =>
      Promise.resolve({
        ok: false,
        code: 'missing_agent',
        message: 'Agent worker is not available.',
        diagnostics: [],
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'preflight_rejected',
      message: 'Agent worker is not available.',
    })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: 'openai-codex/gpt-6-luna:max' }))
  })

  it('rechecks changed host policy; an earlier verification reserves nothing', async () => {
    const resolve = vi.fn<TestResolver>((input) => {
      const modelRemainsScoped = input.scopedModelIds?.includes('openai-codex/gpt-6-luna') === true
      return Promise.resolve(
        modelRemainsScoped
          ? {
              ok: true,
              contract: {
                model: input.model,
                thinking: 'max',
                diagnostics: [],
                tools: { mcp: [] },
              },
            }
          : {
              ok: false,
              code: 'model_scope',
              message: 'The model is no longer in scope.',
              diagnostics: [
                {
                  code: 'model_scope',
                  severity: 'error',
                  message: 'The model is no longer in scope.',
                },
              ],
            },
      )
    })
    const launch = { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() }
    const baseHost = {
      parentModel: { provider: 'openai', id: 'gpt-6-sol' },
      availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
    }

    const first = await verifySubagentRecommendation({
      recommendation,
      launch,
      host: { ...baseHost, scopedModelIds: ['openai-codex/gpt-6-luna'] },
      resolveSubagentLaunchContract: resolve,
    })
    const second = await verifySubagentRecommendation({
      recommendation,
      launch,
      host: { ...baseHost, scopedModelIds: ['openai/gpt-6-sol'] },
      resolveSubagentLaunchContract: resolve,
    })

    expect(first).toEqual({ status: 'verified', selection })
    expect(second).toEqual({
      status: 'verification_failed',
      category: 'preflight_rejected',
      message: 'The model is no longer in scope.',
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls.map(([input]) => input.scopedModelIds)).toEqual([
      ['openai-codex/gpt-6-luna'],
      ['openai/gpt-6-sol'],
    ])
  })

  it('checks the same Pi host snapshot that preflight received', async () => {
    type RuntimeSnapshotHost = NonNullable<Parameters<typeof resolveSubagentLaunchContract>[0]['runtimeSnapshotHost']>
    let resolvePreflight!: (result: TestPreflightResult) => void
    const preflight = new Promise<TestPreflightResult>((resolve) => {
      resolvePreflight = resolve
    })
    const resolve = vi.fn<TestResolver>(() => preflight)
    const host = {
      parentModel: { provider: 'openai', id: 'gpt-6-sol' },
      scopedModelIds: ['openai-codex/gpt-6-luna'],
      availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      runtimeSnapshotHost: undefined as RuntimeSnapshotHost | undefined,
    }
    const verification = verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host,
      resolveSubagentLaunchContract: resolve,
    })

    expect(resolve.mock.calls[0]?.[0].runtimeSnapshotHost).toBeUndefined()
    host.runtimeSnapshotHost = {
      events: { emit: (_event: string, _request: object) => undefined },
      getCommands: () => [],
    }
    resolvePreflight({
      ok: true,
      contract: {
        model: 'openai-codex/gpt-6-luna:max',
        thinking: 'max',
        diagnostics: [],
        tools: { mcp: [{ name: 'mcp__docs__search', selector: 'docs/search' }] },
      },
    })

    expect(await verification).toEqual({
      status: 'verification_failed',
      category: 'host_required',
      message: 'Current host snapshots are required: runtimeSnapshotHost.',
      missingHostFacts: ['runtimeSnapshotHost'],
    })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runtimeSnapshotHost: undefined }))
  })

  it('requires the current Pi host snapshot when direct MCP selections resolve', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [],
          tools: { mcp: [{ name: 'mcp__docs__search', selector: 'docs/search' }] },
        },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'host_required',
      message: 'Current host snapshots are required: runtimeSnapshotHost.',
      missingHostFacts: ['runtimeSnapshotHost'],
    })
  })

  it('forwards the calling Pi host when direct MCP selections resolve', async () => {
    const runtimeSnapshotHost = {
      events: { emit: (_event: string, _request: object) => undefined },
      getCommands: () => [],
    }
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [],
          tools: { mcp: [{ name: 'mcp__docs__search', selector: 'docs/search' }] },
        },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
        runtimeSnapshotHost,
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({ status: 'verified', selection })
    expect(resolve.mock.calls[0]?.[0].runtimeSnapshotHost).toBe(runtimeSnapshotHost)
  })

  it('reports host_required diagnostics returned alongside a preflight rejection', async () => {
    const resolve = vi.fn<TestResolver>(() =>
      Promise.resolve({
        ok: false,
        code: 'invalid_cwd',
        message: 'The launch working directory is invalid.',
        diagnostics: [
          {
            code: 'host_required',
            severity: 'host-required',
            message: 'The current parent-session snapshot is required.',
          },
        ],
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'host_required',
      message: 'The current parent-session snapshot is required.',
      missingHostFacts: ['The current parent-session snapshot is required.'],
    })
  })

  it('returns unresolved_contract when the injected preflight throws without retrying', async () => {
    const resolve = vi.fn<typeof resolveSubagentLaunchContract>(() =>
      Promise.reject(new Error('private preflight detail')),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'The launch preflight could not resolve a contract.',
    })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: 'openai-codex/gpt-6-luna:max' }))
  })

  it('treats blocking public diagnostics as a preflight rejection', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [{ code: 'model_scope', severity: 'error', message: 'The selection is outside scope.' }],
          tools: { mcp: [] },
        },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'preflight_rejected',
      message: 'The selection is outside scope.',
    })
  })

  it('does not verify an external machine placement as a native Pi child', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: { model: input.model, thinking: 'max', diagnostics: [], tools: { mcp: [] } },
      }),
    )
    const launch = {
      agent: 'worker',
      task: 'Implement the requested subtask.',
      cwd: process.cwd(),
      machine: 'remote-worker',
    }

    const result = await verifySubagentRecommendation({
      recommendation,
      launch,
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'Machine placement is outside native Pi launch preflight.',
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects malformed public diagnostics instead of assuming host checks passed', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [{ severity: 'host-required' }],
          tools: { mcp: [] },
        },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toMatchObject({
      status: 'verification_failed',
      category: 'unresolved_contract',
    })
  })

  it('rejects omitted current host snapshots before invoking preflight', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: { model: input.model, thinking: 'max', diagnostics: [], tools: { mcp: [] } },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: undefined,
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      } as never,
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'host_required',
      message: 'Current host snapshots are required: scopedModelIds.',
      missingHostFacts: ['scopedModelIds'],
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when public preflight requires a missing host fact', async () => {
    const resolve = vi.fn<TestResolver>((input) =>
      Promise.resolve({
        ok: true as const,
        contract: {
          model: input.model,
          thinking: 'max',
          diagnostics: [
            {
              code: 'host_required',
              severity: 'host-required',
              message: 'The exact parent session snapshot is required.',
            },
          ],
          tools: { mcp: [] },
        },
      }),
    )

    const result = await verifySubagentRecommendation({
      recommendation,
      launch: { agent: 'worker', task: 'Implement the requested subtask.', cwd: process.cwd() },
      host: {
        parentModel: { provider: 'openai', id: 'gpt-6-sol' },
        scopedModelIds: ['openai-codex/gpt-6-luna'],
        availableModels: [{ provider: 'openai-codex', id: 'gpt-6-luna' }],
      },
      resolveSubagentLaunchContract: resolve,
    })

    expect(result).toEqual({
      status: 'verification_failed',
      category: 'host_required',
      message: 'The exact parent session snapshot is required.',
      missingHostFacts: ['The exact parent session snapshot is required.'],
    })
  })
})
