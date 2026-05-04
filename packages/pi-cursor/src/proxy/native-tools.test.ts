import { create } from '@bufbuild/protobuf'
import { describe, it, expect } from 'vitest'

import { McpToolDefinitionSchema } from '../proto/agent_pb.ts'
import {
  buildEnabledToolSet,
  MCP_TOOL_PREFIX,
  classifyExecMessage,
  fixMcpArgNames,
  stripMcpToolPrefix,
} from './native-tools.ts'

function makeToolDefinition(toolName: string) {
  return create(McpToolDefinitionSchema, { toolName })
}

describe('stripMcpToolPrefix', () => {
  it('strips the prefix', () => {
    expect(stripMcpToolPrefix(`${MCP_TOOL_PREFIX}read`)).toBe('read')
  })

  it('returns unchanged if no prefix', () => {
    expect(stripMcpToolPrefix('read')).toBe('read')
  })
})

describe('buildEnabledToolSet', () => {
  it('builds a set from registered MCP tool definitions', () => {
    const enabledToolNames = buildEnabledToolSet([
      makeToolDefinition(`${MCP_TOOL_PREFIX}read`),
      makeToolDefinition(`${MCP_TOOL_PREFIX}grep`),
    ])

    expect(enabledToolNames).toEqual(new Set(['read', 'grep']))
  })

  it('returns an empty set when no tools are registered', () => {
    expect(buildEnabledToolSet([])).toEqual(new Set())
  })

  it('keeps unprefixed tool names unchanged', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('bash')])

    expect(enabledToolNames).toEqual(new Set(['bash']))
  })
})

describe('fixMcpArgNames', () => {
  it('renames filePath to path for read', () => {
    const args: Record<string, unknown> = { filePath: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.path).toBe('foo.ts')
    expect(args.filePath).toBeUndefined()
  })

  it('does not overwrite existing path', () => {
    const args: Record<string, unknown> = { path: 'bar.ts', filePath: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.path).toBe('bar.ts')
  })

  it('renames filePath to path for write', () => {
    const args: Record<string, unknown> = { filePath: 'out.ts', content: 'hello' }
    fixMcpArgNames('write', args)
    expect(args.path).toBe('out.ts')
  })
})

describe('classifyExecMessage', () => {
  it('classifies readArgs as redirect', () => {
    expect(classifyExecMessage('readArgs')).toBe('redirect')
  })

  it('classifies shellArgs as redirect', () => {
    expect(classifyExecMessage('shellArgs')).toBe('redirect')
  })

  it('classifies mcpArgs as passthrough', () => {
    expect(classifyExecMessage('mcpArgs')).toBe('passthrough')
  })

  it('classifies requestContextArgs as internal', () => {
    expect(classifyExecMessage('requestContextArgs')).toBe('internal')
  })

  it('classifies diagnosticsArgs as reject', () => {
    expect(classifyExecMessage('diagnosticsArgs')).toBe('reject')
  })

  it('classifies unknown exec types as reject', () => {
    expect(classifyExecMessage('unknownArgs')).toBe('reject')
  })
})
