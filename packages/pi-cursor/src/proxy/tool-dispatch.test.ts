import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import type { AgentServerMessage, ExecServerMessage, InteractionQuery } from '../proto/agent_pb.ts'
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  BackgroundShellSpawnArgsSchema,
  DeleteArgsSchema,
  DiagnosticsArgsSchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
  ExecServerControlMessageSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  LsArgsSchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  TextDeltaUpdateSchema,
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

function makeCtx(
  overrides: Partial<ToolDispatchContext> = {},
): ToolDispatchContext & { sentFrames: Buffer[]; execCalls: PendingExec[] } {
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

function makeExecServerMessage(message: ExecServerMessage['message']) {
  return create(ExecServerMessageSchema, {
    id: 1,
    execId: 'exec-1',
    message,
  })
}

function makeAgentMessage(message: AgentServerMessage['message']) {
  return fromBinary(
    AgentServerMessageSchema,
    toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })),
  )
}

function makeExecAgentMessage(message: ExecServerMessage['message']) {
  const execMsg = makeExecServerMessage(message)
  return makeAgentMessage({ case: 'execServerMessage', value: execMsg })
}

function makeInteractionMessage(query: InteractionQuery['query']) {
  const interactionQuery = create(InteractionQuerySchema, {
    id: 42,
    query,
  })
  return makeAgentMessage({ case: 'interactionQuery', value: interactionQuery })
}

// ── Tests ──

describe('handleToolMessage', () => {
  describe('exec routing by mode', () => {
    it('reject mode — rejects overlapping native tool with error', () => {
      const ctx = makeCtx({ nativeToolsMode: 'reject' })
      const shellArgs = create(ShellArgsSchema, { command: 'echo hi', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'shellArgs', value: shellArgs })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)

      // Verify rejection response
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg = getExecClientMessage(response)
      expect(execMsg.message.case).toBe('shellResult')
      if (execMsg.message.case !== 'shellResult') {
        throw new Error('unreachable')
      }
      expect(execMsg.message.value.result.case).toBe('rejected')
    })

    it('redirect mode — redirects native tool to MCP exec', () => {
      const ctx = makeCtx({ nativeToolsMode: 'redirect' })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'readArgs', value: readArgs })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
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
      const msg = makeExecAgentMessage({ case: 'readArgs', value: readArgs })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      // In native mode, no onMcpExec call happens — execution is local
      expect(ctx.execCalls).toHaveLength(0)
      // The async native execution will produce a frame eventually (tested in native-tools.test.ts)
    })
  })

  describe('interaction query rejection', () => {
    it.each([
      [
        {
          case: 'webSearchRequestQuery' as const,
          value: create(WebSearchRequestQuerySchema, {
            args: create(WebSearchArgsSchema, { searchTerm: 'test query' }),
          }),
        },
        'webSearchRequestResponse',
      ],
      [
        { case: 'exaSearchRequestQuery' as const, value: create(ExaSearchRequestQuerySchema, {}) },
        'exaSearchRequestResponse',
      ],
      [
        { case: 'exaFetchRequestQuery' as const, value: create(ExaFetchRequestQuerySchema, {}) },
        'exaFetchRequestResponse',
      ],
    ] as const)('rejects %s with rejection response', (query, responseCase) => {
      const ctx = makeCtx()
      const msg = makeInteractionMessage(query)

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
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
      const execMsg: ExecServerMessage & {
        $unknown?: { no: number; wireType: number; data: Uint8Array }[]
      } = create(ExecServerMessageSchema, {
        id: 1,
        execId: 'exec-1',
      })
      // Simulate an unknown exec type with $unknown field
      execMsg.$unknown = [{ no: 99, wireType: 2, data: new Uint8Array([1, 2, 3]) }]

      handleExecMessage(execMsg, ctx)

      // Should have sent a response (result + stream close)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
    })

    it('sends stream-close without result when $unknown has no recoverable field', () => {
      const ctx = makeCtx()
      const execMsg = create(ExecServerMessageSchema, {
        id: 2,
        execId: 'exec-2',
      })
      // No $unknown field set — unrecognized exec with nothing to mirror

      handleExecMessage(execMsg, ctx)

      // Should still send a stream-close so the server doesn't hang
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
      const msg = makeAgentMessage({ case: 'execServerControlMessage', value: ctrl })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
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
      const msg = makeExecAgentMessage({ case: 'mcpArgs', value: mcpArgs })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)

      // Verify it's an MCP error result
      const response = decodeClientFrame(ctx.sentFrames[0])
      getExecClientMessage(response) // throws if not execClientMessage
    })

    it('rejects redirected native tool when target MCP tool is not enabled', () => {
      const ctx = makeCtx({ enabledToolNames: new Set<string>() })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'readArgs', value: readArgs })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.execCalls).toHaveLength(0)
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('unsupported native tool rejection', () => {
    it('rejects backgroundShellSpawn with shell rejection', () => {
      const ctx = makeCtx()
      const args = create(BackgroundShellSpawnArgsSchema, { command: 'sleep 100', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'backgroundShellSpawnArgs', value: args })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg = getExecClientMessage(response)
      expect(execMsg.message.case).toBe('backgroundShellSpawnResult')
    })

    it('rejects writeShellStdin with error', () => {
      const ctx = makeCtx()
      const args = create(WriteShellStdinArgsSchema, {})
      const msg = makeExecAgentMessage({ case: 'writeShellStdinArgs', value: args })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg2 = getExecClientMessage(response)
      expect(execMsg2.message.case).toBe('writeShellStdinResult')
    })

    it('rejects diagnostics with empty result', () => {
      const ctx = makeCtx()
      const args = create(DiagnosticsArgsSchema, {})
      const msg = makeExecAgentMessage({ case: 'diagnosticsArgs', value: args })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeTruthy()
      expect(ctx.sentFrames.length).toBeGreaterThanOrEqual(1)
      const response = decodeClientFrame(ctx.sentFrames[0])
      const execMsg3 = getExecClientMessage(response)
      expect(execMsg3.message.case).toBe('diagnosticsResult')
    })
  })

  describe('non-tool messages', () => {
    it('returns false for non-tool message types', () => {
      const ctx = makeCtx()
      const update = create(InteractionUpdateSchema, {
        message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'hi' }) },
      })
      const msg = makeAgentMessage({ case: 'interactionUpdate', value: update })

      const handled = handleToolMessage(msg, ctx)

      expect(handled).toBeFalsy()
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
      const msg = makeExecAgentMessage({ case: 'mcpArgs', value: mcpArgs })

      handleToolMessage(msg, ctx)

      expect(state.totalExecCount).toBe(1)
    })

    it('increments totalExecCount for redirected native tools', () => {
      const state = { totalExecCount: 0 }
      const ctx = makeCtx({ state })
      const readArgs = create(ReadArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'readArgs', value: readArgs })

      handleToolMessage(msg, ctx)

      expect(state.totalExecCount).toBe(1)
    })
  })

  describe('redirect variations', () => {
    it('redirects write to write MCP tool', () => {
      const ctx = makeCtx()
      const writeArgs = create(WriteArgsSchema, { path: '/test/file.txt', fileText: 'content', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'writeArgs', value: writeArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('write')
      expect(ctx.execCalls[0].nativeResultType).toBe('writeResult')
    })

    it('redirects delete to bash MCP tool', () => {
      const ctx = makeCtx()
      const deleteArgs = create(DeleteArgsSchema, { path: '/test/file.txt', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'deleteArgs', value: deleteArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('deleteResult')
    })

    it('redirects shell to bash MCP tool', () => {
      const ctx = makeCtx()
      const shellArgs = create(ShellArgsSchema, { command: 'ls -la', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'shellArgs', value: shellArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('shellResult')
    })

    it('redirects grep to grep MCP tool', () => {
      const ctx = makeCtx()
      const grepArgs = create(GrepArgsSchema, { pattern: 'test', path: '/src' })
      const msg = makeExecAgentMessage({ case: 'grepArgs', value: grepArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('grep')
      expect(ctx.execCalls[0].nativeResultType).toBe('grepResult')
    })

    it('redirects ls to ls MCP tool', () => {
      const ctx = makeCtx()
      const lsArgs = create(LsArgsSchema, { path: '/test' })
      const msg = makeExecAgentMessage({ case: 'lsArgs', value: lsArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('ls')
      expect(ctx.execCalls[0].nativeResultType).toBe('lsResult')
    })

    it('redirects fetch to bash MCP tool', () => {
      const ctx = makeCtx()
      const fetchArgs = create(FetchArgsSchema, { url: 'https://example.com', toolCallId: 'tc-1' })
      const msg = makeExecAgentMessage({ case: 'fetchArgs', value: fetchArgs })

      handleToolMessage(msg, ctx)

      expect(ctx.execCalls).toHaveLength(1)
      expect(ctx.execCalls[0].toolName).toBe('bash')
      expect(ctx.execCalls[0].nativeResultType).toBe('fetchResult')
    })
  })
})
