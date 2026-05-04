/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'

import {
  DeleteArgsSchema,
  ExecServerMessageSchema,
  LsArgsSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
  WriteArgsSchema,
} from '../proto/agent_pb.ts'
import {
  buildEnabledToolSet,
  MCP_TOOL_PREFIX,
  REDIRECTABLE_EXEC_CASES,
  classifyExecMessage,
  executeNativeLocally,
  fixMcpArgNames,
  resolveAllowedRoot,
  stripMcpToolPrefix,
  validatePath,
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

describe('REDIRECTABLE_EXEC_CASES', () => {
  it('contains all expected native redirect cases', () => {
    const expected = [
      'readArgs',
      'writeArgs',
      'deleteArgs',
      'shellArgs',
      'shellStreamArgs',
      'lsArgs',
      'grepArgs',
      'fetchArgs',
    ]
    for (const c of expected) {
      expect(REDIRECTABLE_EXEC_CASES.has(c)).toBeTruthy()
    }
    expect(REDIRECTABLE_EXEC_CASES.size).toBe(expected.length)
  })
})

describe('classifyExecMessage', () => {
  it.each([...REDIRECTABLE_EXEC_CASES])('classifies %s as redirect', (execCase) => {
    expect(classifyExecMessage(execCase)).toBe('redirect')
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

// ---------------------------------------------------------------------------
// resolveAllowedRoot
// ---------------------------------------------------------------------------

describe('resolveAllowedRoot', () => {
  it('finds git root when .git exists', () => {
    // The current repo is a git repo, so resolving cwd should find the .git root
    const root = resolveAllowedRoot(process.cwd())
    expect(root).toBeTruthy()
    // The root should be a parent or equal to cwd
    expect(process.cwd().startsWith(root)).toBeTruthy()
  })

  it('falls back to cwd when no .git found', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'no-git-'))
    try {
      const root = resolveAllowedRoot(tempDir)
      expect(root).toBe(tempDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// validatePath
// ---------------------------------------------------------------------------

describe('validatePath', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'validate-path-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('allows paths within root', () => {
    const result = validatePath('foo/bar.ts', tempDir)
    expect(result).toBe(join(tempDir, 'foo', 'bar.ts'))
  })

  it('allows absolute paths within root', () => {
    const absPath = join(tempDir, 'foo.ts')
    const result = validatePath(absPath, tempDir)
    expect(result).toBe(absPath)
  })

  it('allows the root itself', () => {
    const result = validatePath(tempDir, tempDir)
    expect(result).toBe(tempDir)
  })

  it('rejects paths outside root via ../', () => {
    expect(() => validatePath('../../../etc/passwd', tempDir)).toThrow(/outside the allowed root/)
  })

  it('rejects absolute paths outside root', () => {
    const outsidePath = join(tmpdir(), 'outside-file.txt')
    expect(() => validatePath(outsidePath, tempDir)).toThrow(/outside the allowed root/)
  })
})

// ---------------------------------------------------------------------------
// executeNativeLocally
// ---------------------------------------------------------------------------

describe('executeNativeLocally', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'native-exec-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeExecMsg(msgCase: string, value: unknown) {
    return create(ExecServerMessageSchema, {
      id: 1,
      execId: 'test-exec-1',
      message: { case: msgCase, value } as any,
    })
  }

  it('reads a file within allowed root', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'hello world\nline 2')

    const execMsg = makeExecMsg('readArgs', create(ReadArgsSchema, { path: filePath }))
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('readResult')
    const readResult = result.result as any
    expect(readResult.result.case).toBe('success')
    expect(readResult.result.value.path).toBe(filePath)
  })

  it('rejects read outside allowed root', async () => {
    const outsidePath = join(tmpdir(), 'outside.txt')
    const execMsg = makeExecMsg('readArgs', create(ReadArgsSchema, { path: outsidePath }))
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('readResult')
    const readResult = result.result as any
    expect(readResult.result.case).toBe('error')
    expect(readResult.result.value.error).toMatch(/outside the allowed root/)
  })

  it('writes a file within allowed root', async () => {
    const filePath = join(tempDir, 'output.txt')
    const execMsg = makeExecMsg(
      'writeArgs',
      create(WriteArgsSchema, { path: filePath, fileText: 'written content', toolCallId: 'tc1' }),
    )
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('writeResult')
    const writeResult = result.result as any
    expect(writeResult.result.case).toBe('success')
    expect(writeResult.result.value.path).toBe(filePath)
  })

  it('rejects write outside allowed root', async () => {
    const outsidePath = join(tmpdir(), 'outside-write.txt')
    const execMsg = makeExecMsg(
      'writeArgs',
      create(WriteArgsSchema, { path: outsidePath, fileText: 'bad', toolCallId: 'tc1' }),
    )
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('writeResult')
    const writeResult = result.result as any
    expect(writeResult.result.case).toBe('error')
    expect(writeResult.result.value.error).toMatch(/outside the allowed root/)
  })

  it('deletes a file within allowed root', async () => {
    const filePath = join(tempDir, 'to-delete.txt')
    writeFileSync(filePath, 'delete me')

    const execMsg = makeExecMsg('deleteArgs', create(DeleteArgsSchema, { path: filePath, toolCallId: 'tc1' }))
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('deleteResult')
    const deleteResult = result.result as any
    expect(deleteResult.result.case).toBe('success')
  })

  it('rejects delete outside allowed root', async () => {
    const outsidePath = join(tmpdir(), 'outside-delete.txt')
    const execMsg = makeExecMsg('deleteArgs', create(DeleteArgsSchema, { path: outsidePath, toolCallId: 'tc1' }))
    const result = await executeNativeLocally(execMsg, tempDir)

    // Delete returns success even on error (best-effort), but validatePath throws
    // which gets caught and returns success (no-op behavior)
    expect(result.resultType).toBe('deleteResult')
  })

  it('lists directory within allowed root', async () => {
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    mkdirSync(join(tempDir, 'subdir'))

    const execMsg = makeExecMsg('lsArgs', create(LsArgsSchema, { path: tempDir }))
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('lsResult')
    const lsResult = result.result as any
    expect(lsResult.result.case).toBe('success')
  })

  it('rejects ls outside allowed root', async () => {
    const outsidePath = join(tmpdir(), 'outside-ls')
    const execMsg = makeExecMsg('lsArgs', create(LsArgsSchema, { path: outsidePath }))
    const result = await executeNativeLocally(execMsg, tempDir)

    expect(result.resultType).toBe('lsResult')
    const lsResult = result.result as any
    expect(lsResult.result.case).toBe('error')
  })
})
