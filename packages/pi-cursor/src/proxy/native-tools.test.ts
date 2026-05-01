import { describe, it, expect } from 'vitest'

import { MCP_TOOL_PREFIX, classifyExecMessage, fixMcpArgNames, stripMcpToolPrefix } from './native-tools.ts'

describe('stripMcpToolPrefix', () => {
  it('strips the prefix', () => {
    expect(stripMcpToolPrefix(`${MCP_TOOL_PREFIX}read`)).toBe('read')
  })

  it('returns unchanged if no prefix', () => {
    expect(stripMcpToolPrefix('read')).toBe('read')
  })
})

describe('fixMcpArgNames', () => {
  it('renames path to filePath for read', () => {
    const args: Record<string, unknown> = { path: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.filePath).toBe('foo.ts')
    expect(args.path).toBeUndefined()
  })

  it('does not overwrite existing filePath', () => {
    const args: Record<string, unknown> = { filePath: 'bar.ts', path: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.filePath).toBe('bar.ts')
  })

  it('renames path to filePath for write', () => {
    const args: Record<string, unknown> = { path: 'out.ts', content: 'hello' }
    fixMcpArgNames('write', args)
    expect(args.filePath).toBe('out.ts')
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
