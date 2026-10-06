import type { ClassifierContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import { describe, expect, it } from 'vitest'

import { registerModelAdvisorExtension } from './index.ts'
import {
  chatModel,
  validClassifierResult,
  validRecommendationConfiguration,
  validRecommendationRequest,
} from './test-fixtures.ts'
import { RecommendationRequestSchema, RecommendationResultSchema, type RecommendationResult } from './types.ts'

type AdvisorTool = ToolDefinition<typeof RecommendationRequestSchema, RecommendationResult>

async function registerAdvisorTool(): Promise<{ definition: AdvisorTool; definitions: AdvisorTool[] }> {
  const definitions: AdvisorTool[] = []
  const registerTool = ((tool: AdvisorTool) => definitions.push(tool)) as unknown as ExtensionAPI['registerTool']
  const registerCommand: ExtensionAPI['registerCommand'] = () => undefined
  const configuration = validRecommendationConfiguration()
  await registerModelAdvisorExtension(
    { registerCommand, registerTool },
    { loadConfiguration: () => Promise.resolve(configuration) },
  )
  return { definition: definitions[0], definitions }
}

describe('registerModelAdvisorExtension', () => {
  it('registers one read-only native tool with matching Pi TypeBox schemas', async () => {
    const { definition, definitions } = await registerAdvisorTool()

    expect(definitions).toHaveLength(1)
    expect(definition).toMatchObject({
      name: 'recommend_subagent_model',
      parameters: RecommendationRequestSchema,
      outputSchema: RecommendationResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    })
    expect(definition.exposure).toBeUndefined()
  })

  it('returns structured recommendations and forwards native usage through Pi accounting', async () => {
    const { definition } = await registerAdvisorTool()
    const classifierContexts: ClassifierContext[] = []
    const context = {
      scopedModels: [],
      signal: undefined,
      modelRegistry: {
        getAvailable: () => [chatModel()],
        getAvailableOfType: () => Promise.resolve([{ provider: 'llama.cpp', id: 'offline-classifier' }]),
        getModelOfType: () => ({
          type: 'classifier',
          provider: 'llama.cpp',
          id: 'offline-classifier',
          api: 'llama-cpp-classify',
          name: 'offline classifier',
          baseUrl: 'http://127.0.0.1:8080',
          input: ['text'],
        }),
        classify: (_model: unknown, classifierContext: ClassifierContext) => {
          classifierContexts.push(classifierContext)
          return Promise.resolve(validClassifierResult())
        },
      },
    } as unknown as ExtensionToolContext

    const result = await definition.execute('call-1', validRecommendationRequest(), undefined, undefined, context)

    expect(result.isError).toBeUndefined()
    expect(result.details).toMatchObject({ status: 'recommended' })
    expect(result.structuredContent).toEqual(result.details)
    expect(Value.Check(RecommendationResultSchema, result.structuredContent)).toBeTruthy()
    expect(result.usage).toEqual(validClassifierResult().usage)
    expect(classifierContexts).toHaveLength(1)
    expect(classifierContexts[0].state).toMatchObject({ task: validRecommendationRequest().task })
  })

  it('returns a typed configuration failure without classifier execution when no configured classifier is available', async () => {
    const { definition } = await registerAdvisorTool()
    let classificationCalled = false
    const context = {
      scopedModels: [],
      signal: undefined,
      modelRegistry: {
        getAvailable: () => [chatModel()],
        getAvailableOfType: () => Promise.resolve([]),
        getModelOfType: () => undefined,
        classify: () => {
          classificationCalled = true
          return Promise.resolve(validClassifierResult())
        },
      },
    } as unknown as ExtensionToolContext

    const result = await definition.execute('call-1', validRecommendationRequest(), undefined, undefined, context)

    expect(result.isError).toBeTruthy()
    expect(result.structuredContent).toMatchObject({ status: 'configuration_error' })
    expect(Value.Check(RecommendationResultSchema, result.structuredContent)).toBeTruthy()
    expect(classificationCalled).toBeFalsy()
  })
})
