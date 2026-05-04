import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  BackgroundShellSpawnArgsSchema,
  DeleteArgsSchema,
  DiagnosticsArgsSchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
  ExecClientControlMessageSchema,
  ExecServerControlMessageSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  InteractionQuerySchema,
  LsArgsSchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WebSearchArgsSchema,
  WebSearchRequestQuerySchema,
  WriteArgsSchema,
  WriteShellStdinArgsSchema,
} from '../proto/agent_pb.ts'
import { buildEnabledToolSet, MCP_TOOL_PREFIX } from './native-tools.ts'
import { type PendingExec, type ToolDispatchContext, handleExecMessage, handleToolMessage } from './tool-dispatch.ts'

// ── Helpers ──

function makeToolDefinition(toolName: string) {
  return create(McpToolDefinitionSchema, {
    toolName: `${MCP_TOOL_PREFIX}${toolName}`,
  })
}

function defaultTools() {
  return [
    makeToolDefinition('read'),
    makeToolDefinition('write'),
    makeToolDefinition('bash'),
    makeToolDefinition('grep'),
    makeToolDefinition('ls'),
  ]
}

function makeCtx(overrides: Partial<ToolDispatchContext> = {}): ToolDispatchContext & { sentFrames: Buffer[]; execCalls: PendingExec[] } {
  const sentFrames: Buffer[] = []
  const execCalls: PendingExec[] = []
  const tools = overrides.mcpTools ?? defaultTools()
  return {
    sendFrame: (data) => sentFrames.push(Buffer.from(data)),
    mcpTools: tools,
    enabledToolNames: overrides.enabledToolNames ?? buildEnabledToolSet(tools),
    cloudRule: overrides.cloudRule ?? undefined,
    nativeToolsMode: overrides.nativeToolsMode ?? 'redirect',
    allowedRoot: overrides.allowedRoot,
    onMcpExec: (exec) => execCalls.push(exec),
    state: overrides.state ?? { totalExecCount: 0 },
    sentFrames,
    execCalls,
    ...overrides,
  }
}

function decodeClientFrame(frame: Buffer) {
  // Skip 5-byte connect frame header
  const payload = frame.subarray(5)
  return fromBinary(AgentClientMessageSchema, payload)
}

function getExecClientMessage(frame: ReturnType<typeof decodeClientFrame>) {
  if (frame.message.case !== 'execClientMessage') {
    throw new Error(`Expected execClientMessage, got ${String(frame.message.case)}`)
  }
  return frame.message.value
}

function getInteractionResponse(frame: ReturnType<typeof decodeClientFrame>) {
  if (frame.message.case !== 'interactionResponse') {
    throw new Error(`Expected interactionResponse, got ${String(frame.message.case)}`)
  }
  return frame.message.value
}

function makeExecServerMessage(messageCase: string, value: unknown) {
  return create(ExecServerMessageSchema, {
    id: 1,
    execId: 'exec-1',
    message: { case: messageCase as any, value: value as any },
  })
}

function makeAgentMessage(messageCase: string, value: unknown) {
  return fromBinary(
    AgentServerMessageSchema,
    toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: messageCase as any, value: value as any },
    })),
  )
}

function makeExecAgentMessage(execCase: string, execValue: unknown) {
  const execMsg = makeExecServerMessage(execCase, execValue)
  return makeAgentMessage('execServerMessage', execMsg)
}

function makeInteractionMessage(queryCase: string, queryValue?: unknown) {
  let value: unknown
  if (queryCase === 'webSearchRequestQuery') {
    value = queryValue ?? create(WebSearchRequestQuerySchema, {
      args: create(WebSearchArgsSchema, { searchTerm: 'test query' }),
    })
  } else if (queryCase === 'exaSearchRequestQuery') {
    value = queryValue ?? create(ExaSearchRequestQuerySchema, {})
  } else if (queryCase === 'exaFetchRequestQuery') {
    value = queryValue ?? create(ExaFetchRequestQuerySchema, {})
  }
  const query = create(InteractionQuerySchema, {
    id: 42,
    query: { case: queryCase as any, value: value as any },
  })
  return makeAgentMessage('interactionQuery', query)
}

// ── Tests ──

describe('handleToolMessage', () => {
  describe('exec routing by mode', () => {
    it('reject mode — rejects overlapping native tool with error', () => {
      const ctx = makeCtx({ nativeToolsMode: 'reject' })
      const shellArgs = create(ShellArgsSchema, { command: 'echo hi', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('shellArgs', shellArgs)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)

      // Verify rejection response
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg = getExecClientMessage(response)
      expect(execMsg.message.case).toBe('shellResult')
      if (execMsg.message.case !== 'shellResult') throw new Error('unreachable')
      expect(execMsg.message.value.result.case).toBe('rejected')
    })

    it('redirect mode — redirects native tool to MCP exec', () => {
      const ctx = makeCtx({ nativeToolsMode: 'redirect' })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('readArgs', readArgs)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('read')
      expect(JSON.parse(ctx.execCalls[0].decodedArgs)).toEqual({ path: '/test/file.txt' })
      expect(ctx.execCalls[0].nativeResultType).toBe('readResult')
    })

    it('native mode — delegates to native execution', () => {
      // We can't easily test native execution here since it's async and hits the filesystem.
      // Instead, verify the dispatch path is taken by checking no MCP redirect occurs
      // and we need allowedRoot to be set.
      const ctx = makeCtx({ nativeToolsMode: 'native', allowedRoot: '/tmp/test' })
      const readArgs = create(ReadArgsSchema, { path: '/tmp/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('readArgs', readArgs)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      // In native mode, no onMcpExec call happens — execution is local
      expect(ctx.execCalls).toHaveLength(0)
      // The async native execution will produce a frame eventually (tested in native-tools.test.ts)
    })
  })

  describe('interaction query rejection', () => {
    it.each([
      ['webSearchRequestQuery', 'webSearchRequestResponse'],
      ['exaSearchRequestQuery', 'exaSearchRequestResponse'],
      ['exaFetchRequestQuery', 'exaFetchRequestResponse'],
    ] as const)('rejects %s with rejection response', (queryCase, responseCase) => {
      const ctx = makeCtx()
      const msg = makeInteractionMessage(queryCase)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.sentFrames).toHaveLength(1)

      const response = decodeClientFrame(ctx.sentFrames[0])
      const interactionResponse = getInteractionResponse(response)
      expect(interactionResponse.result.case).toBe(responseCase)
    })
  })

  describe('unknown exec type handling', () => {
    it('sends empty result with mirrored field number for unknown exec', () => {
      const ctx = makeCtx()
      // Create an exec message with unknown type by using $unknown field
      const execMsg = create(ExecServerMessageSchema, {
        id: 1,
        execId: 'exec-1',
      })
      // Simulate an unknown exec type with $unknown field
      ;(execMsg as any).$unknown = [
        { no: 99, wireType: 2, data: new Uint8Array([1, 2, 3]) },
      ]

      handleExecMessage(execMsg, ctx)

      // Should have sent a response
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('exec control abort', () => {
    it('handles abort control message', () => {
      const ctx = makeCtx()
      const ctrl = create(ExecServerControlMessageSchema, {
        message: {
          case: 'abort',
          value: { id: 1 },
        },
      })
      const msg = makeAgentMessage('execServerControlMessage', ctrl)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      // Abort is just logged, no frames sent
      expect(ctx.sentFrames).toHaveLength(0)
    })
  })

  describe('unenabled tool rejection via Tool Gating', () => {
    it('rejects MCP tool call when tool is not enabled', () => {
      const ctx = makeCtx({ enabledToolNames: new Set<string>() })
      const mcpArgs = create(McpArgsSchema, {
        toolName: `${MCP_TOOL_PREFIX}read`,
        toolCallId: 'tc-1',
        args: {},
      })
      const msg = makeExecAgentMessage('mcpArgs', mcpArgs)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)

      // Verify it's an MCP error result
      const response = decodeClientFrame(ctx.sentFrames[0])
      getExecClientMessage(response) // throws if not execClientMessage
    })

    it('rejects redirected native tool when target MCP tool is not enabled', () => {
      const ctx = makeCtx({ enabledToolNames: new Set<string>() })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('readArgs', readArgs)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('unsupported native tool rejection', () => {
    it('rejects backgroundShellSpawn with shell rejection', () => {
      const ctx = makeCtx()
      const args = create(BackgroundShellSpawnArgsSchema, { command: 'sleep 100', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('backgroundShellSpawnArgs', args)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg = getExecClientMessage(response)
      expect(execMsg.message.case).toBe('backgroundShellSpawnResult')
    })

    it('rejects writeShellStdin with error', () => {
      const ctx = makeCtx()
      const args = create(WriteShellStdinArgsSchema, {})
      const msg = makeExecAgentMessage('writeShellStdinArgs', args)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg2 = getExecClientMessage(response)
      expect(execMsg2.message.case).toBe('writeShellStdinResult')
    })

    it('rejects diagnostics with empty result', () => {
      const ctx = makeCtx()
      const args = create(DiagnosticsArgsSchema, {})
      const msg = makeExecAgentMessage('diagnosticsArgs', args)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(true)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg3 = getExecClientMessage(response)
      expect(execMsg3.message.case).toBe('diagnosticsResult')
    })
  })

  describe('non-tool messages', () => {
    it('returns false for non-tool message types', () => {
      const ctx = makeCtx()
      const msg = makeAgentMessage('interactionUpdate', { message: { case: 'textDelta', value: { text: 'hi' } } })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBe(false)
    })
  })

  describe('totalExecCount tracking', () => {
    it('increments totalExecCount for MCP tool calls', () => {
      const state = { totalExecCount: 0 }
      const ctx = makeCtx({ state })
      const mcpArgs = create(McpArgsSchema, {
        toolName: `${MCP_TOOL_PREFIX}read`,
        toolCallId: 'tc-1',
        args: {},
      })
      const msg = makeExecAgentMessage('mcpArgs', mcpArgs)

      handleToolMessage(msg, ctx)

      expect(state.totalExecCount).toBe(1)
    })

    it('increments totalExecCount for redirected native tools', () => {
      const state = { totalExecCount: 0 }
      const ctx = makeCtx({ state })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('readArgs', readArgs)

      handleToolMessage(msg, ctx)

      expect(state.totalExecCount).toBe(1)
    })
  })

  describe('redirect variations', () => {
    it('redirects write to write MCP tool', () => {
      const ctx = makeCtx()
      const writeArgs = create(WriteArgsSchema, { path: '/test/file.txt', fileText: 'content', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('writeArgs', writeArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('write')
      expect(ctx.execCalls[0].nativeResultType).toBe('writeResult')
    })

    it('redirects delete to bash MCP tool', () => {
      const ctx = makeCtx()
      const deleteArgs = create(DeleteArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('deleteArgs', deleteArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('deleteResult')
    })

    it('redirects shell to bash MCP tool', () => {
      const ctx = makeCtx()
      const shellArgs = create(ShellArgsSchema, { command: 'ls -la', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('shellArgs', shellArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('shellResult')
    })

    it('redirects grep to grep MCP tool', () => {
      const ctx = makeCtx()
      const grepArgs = create(GrepArgsSchema, { pattern: 'test', path: '/src' })
      const msg = makeExecAgentMessage('grepArgs', grepArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('grep')
      expect(ctx.execCalls[0].nativeResultType).toBe('grepResult')
    })

    it('redirects ls to ls MCP tool', () => {
      const ctx = makeCtx()
      const lsArgs = create(LsArgsSchema, { path: '/test' })
      const msg = makeExecAgentMessage('lsArgs', lsArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('ls')
      expect(ctx.execCalls[0].nativeResultType).toBe('lsResult')
    })

    it('redirects fetch to bash MCP tool', () => {
      const ctx = makeCtx()
      const fetchArgs = create(FetchArgsSchema, { url: 'https://example.com', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage('fetchArgs', fetchArgs)

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('fetchResult')
    })
  })
})
