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
      contract: { model: string | undefined; thinking: string; diagnostics: unknown[] }
    }
  | { ok: false; message: string }
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

  it.each([
    { field: 'provider', model: 'openai/gpt-6-luna:max', thinking: 'max' },
    { field: 'model', model: 'openai-codex/gpt-6-sol:max', thinking: 'max' },
    { field: 'thinking', model: 'openai-codex/gpt-6-luna:low', thinking: 'low' },
  ])('rejects a preflight-adjusted $field without substitution', async ({ model, thinking }) => {
    const resolve = vi.fn<TestResolver>((_input) =>
      Promise.resolve({
        ok: true as const,
        contract: { model, thinking, diagnostics: [] },
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
        contract: { model: input.model, thinking: 'max', diagnostics: [] },
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
        contract: { model: input.model, thinking: 'max', diagnostics: [] },
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
        contract: { model: input.model, thinking: 'max', diagnostics: [] },
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
