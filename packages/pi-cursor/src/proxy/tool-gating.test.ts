import { create, fromBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
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
} from '../proto/agent_pb.ts'
import {
  createStreamState,
  type ExecContext,
  handleExecMessage,
  processServerMessage,
  type PendingExec,
} from './cursor-messages.ts'
import { buildEnabledToolSet, MCP_TOOL_PREFIX } from './native-tools.ts'

const TOOL_DISABLED_REASON = (toolName: string): string => `Tool '${toolName}' is not enabled in this session`

function makeToolDefinition(toolName: string) {
  return create(McpToolDefinitionSchema, {
    toolName: `${MCP_TOOL_PREFIX}${toolName}`,
  })
}

function decodeClientFrame(frame: Buffer) {
  return fromBinary(AgentClientMessageSchema, frame.subarray(5))
}

function getExecClientMessage(frame: ReturnType<typeof decodeClientFrame>) {
  if (frame.message.case !== 'execClientMessage') {
    throw new Error(`Expected execClientMessage, got ${String(frame.message.case)}`)
  }
  return frame.message.value
}

function getMcpResult(frame: ReturnType<typeof decodeClientFrame>) {
  const execClientMessage = getExecClientMessage(frame)
  if (execClientMessage.message.case !== 'mcpResult') {
    throw new Error(`Expected mcpResult, got ${String(execClientMessage.message.case)}`)
  }
  return execClientMessage.message.value
}

function getShellResult(frame: ReturnType<typeof decodeClientFrame>) {
  const execClientMessage = getExecClientMessage(frame)
  if (execClientMessage.message.case !== 'shellResult') {
    throw new Error(`Expected shellResult, got ${String(execClientMessage.message.case)}`)
  }
  return execClientMessage.message.value
}

function getInteractionResponse(frame: ReturnType<typeof decodeClientFrame>) {
  if (frame.message.case !== 'interactionResponse') {
    throw new Error(`Expected interactionResponse, got ${String(frame.message.case)}`)
  }
  return frame.message.value
}

// ── Exec message factories ──

function makeMcpExecMessage(toolName: string) {
  return create(ExecServerMessageSchema, {
    id: 1,
    execId: 'exec-mcp-1',
    message: {
      case: 'mcpArgs',
      value: create(McpArgsSchema, {
        toolName: `${MCP_TOOL_PREFIX}${toolName}`,
        toolCallId: 'tool-call-1',
        args: {
          path: new TextEncoder().encode('notes.txt'),
        },
      }),
    },
  })
}

function makeReadExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 2,
    execId: 'exec-read-1',
    message: {
      case: 'readArgs',
      value: create(ReadArgsSchema, {
        path: 'notes.txt',
      }),
    },
  })
}

function makeWriteExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 4,
    execId: 'exec-write-1',
    message: {
      case: 'writeArgs',
      value: create(WriteArgsSchema, {
        path: 'output.txt',
        fileText: 'hello world',
      }),
    },
  })
}

function makeDeleteExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 5,
    execId: 'exec-delete-1',
    message: {
      case: 'deleteArgs',
      value: create(DeleteArgsSchema, {
        path: '/tmp/test.txt',
      }),
    },
  })
}

function makeGrepExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 6,
    execId: 'exec-grep-1',
    message: {
      case: 'grepArgs',
      value: create(GrepArgsSchema, {
        pattern: 'TODO',
        path: 'src/',
      }),
    },
  })
}

function makeLsExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: 'exec-ls-1',
    message: {
      case: 'lsArgs',
      value: create(LsArgsSchema, {
        path: '.',
      }),
    },
  })
}

function makeFetchExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 8,
    execId: 'exec-fetch-1',
    message: {
      case: 'fetchArgs',
      value: create(FetchArgsSchema, {
        url: 'https://example.com',
      }),
    },
  })
}

function makeShellExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 3,
    execId: 'exec-shell-1',
    message: {
      case: 'shellArgs',
      value: create(ShellArgsSchema, {
        command: 'pwd',
      }),
    },
  })
}

function makeShellStreamExecMessage() {
  return create(ExecServerMessageSchema, {
    id: 9,
    execId: 'exec-shell-stream-1',
    message: {
      case: 'shellStreamArgs',
      value: create(ShellArgsSchema, {
        command: 'pwd',
      }),
    },
  })
}

// ── Test helpers ──

function runExec(execMsg: ReturnType<typeof makeMcpExecMessage>, enabledToolNames: Set<string>) {
  const sentFrames: Buffer[] = []
  const execs: PendingExec[] = []

  const ctx: ExecContext = {
    mcpTools: [],
    enabledToolNames,
    cloudRule: undefined,
    sendFrame: (data) => sentFrames.push(Buffer.from(data)),
    onMcpExec: (exec) => execs.push(exec),
    state: createStreamState(),
  }

  handleExecMessage(execMsg, ctx)

  return { execs, sentFrames }
}

function makeInteractionMessage(queryCase: 'webSearchRequestQuery' | 'exaSearchRequestQuery' | 'exaFetchRequestQuery') {
  if (queryCase === 'webSearchRequestQuery') {
    return create(AgentServerMessageSchema, {
      message: {
        case: 'interactionQuery',
        value: create(InteractionQuerySchema, {
          id: 11,
          query: {
            case: 'webSearchRequestQuery',
            value: create(WebSearchRequestQuerySchema, {
              args: create(WebSearchArgsSchema, {
                searchTerm: 'pi cursor',
                toolCallId: 'web-1',
              }),
            }),
          },
        }),
      },
    })
  }

  if (queryCase === 'exaSearchRequestQuery') {
    return create(AgentServerMessageSchema, {
      message: {
        case: 'interactionQuery',
        value: create(InteractionQuerySchema, {
          id: 12,
          query: {
            case: 'exaSearchRequestQuery',
            value: create(ExaSearchRequestQuerySchema, {}),
          },
        }),
      },
    })
  }

  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionQuery',
      value: create(InteractionQuerySchema, {
        id: 13,
        query: {
          case: 'exaFetchRequestQuery',
          value: create(ExaFetchRequestQuerySchema, {}),
        },
      }),
    },
  })
}

// ── Assertion helpers ──

function expectMcpError(sentFrames: Buffer[], expectedReason: string) {
  expect(sentFrames).toHaveLength(2)

  const resultFrame = decodeClientFrame(sentFrames[0])
  const mcpResult = getMcpResult(resultFrame)
  expect(mcpResult.result.case).toBe('success')
  if (mcpResult.result.case !== 'success') {
    throw new Error(`Expected successful MCP result, got ${String(mcpResult.result.case)}`)
  }

  const success = mcpResult.result.value
  expect(success.isError).toBeTruthy()

  const textContent = success.content[0].content
  expect(textContent.case).toBe('text')
  if (textContent.case !== 'text') {
    throw new Error(`Expected text MCP content, got ${String(textContent.case)}`)
  }
  expect(textContent.value.text).toBe(expectedReason)

  const closeFrame = decodeClientFrame(sentFrames[1])
  expect(closeFrame.message.case).toBe('execClientControlMessage')
}

function expectShellRejected(sentFrames: Buffer[], expectedReason: string, expectedCommand = 'pwd') {
  expect(sentFrames).toHaveLength(2)

  const resultFrame = decodeClientFrame(sentFrames[0])
  const shellResult = getShellResult(resultFrame)
  expect(shellResult.result.case).toBe('rejected')
  if (shellResult.result.case !== 'rejected') {
    throw new Error(`Expected rejected shell result, got ${String(shellResult.result.case)}`)
  }

  const rejected = shellResult.result.value
  expect(rejected.command).toBe(expectedCommand)
  expect(rejected.reason).toBe(expectedReason)

  const closeFrame = decodeClientFrame(sentFrames[1])
  expect(closeFrame.message.case).toBe('execClientControlMessage')
}

// ── MCP passthrough gating ──

describe('handleExecMessage MCP passthrough gating', () => {
  it('passes through enabled MCP tools', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('read')])
    const { execs, sentFrames } = runExec(makeMcpExecMessage('read'), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      execId: 'exec-mcp-1',
      execMsgId: 1,
      toolCallId: 'tool-call-1',
      toolName: 'read',
      decodedArgs: JSON.stringify({ path: 'notes.txt' }),
    })
  })

  it('rejects disabled MCP tools with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('write')])
    const { execs, sentFrames } = runExec(makeMcpExecMessage('read'), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('read'))
  })

  it('rejects MCP tools when tool set is empty', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeMcpExecMessage('read'), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('read'))
  })
})

// ── Native redirect gating: read ──

describe('handleExecMessage native redirect gating', () => {
  it('passes through enabled native read redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('read')])
    const { execs, sentFrames } = runExec(makeReadExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      execId: 'exec-read-1',
      execMsgId: 2,
      toolName: 'read',
      decodedArgs: JSON.stringify({ path: 'notes.txt' }),
      nativeResultType: 'readResult',
      nativeArgs: { path: 'notes.txt' },
    })
  })

  it('rejects disabled read redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeReadExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('read'))
  })

  // ── write ──

  it('passes through enabled native write redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('write')])
    const { execs, sentFrames } = runExec(makeWriteExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'write',
      nativeResultType: 'writeResult',
    })
  })

  it('rejects disabled write redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeWriteExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('write'))
  })

  // ── delete (maps to bash) ──

  it('passes through enabled native delete redirect (maps to bash)', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('bash')])
    const { execs, sentFrames } = runExec(makeDeleteExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'bash',
      nativeResultType: 'deleteResult',
    })
  })

  it('rejects disabled delete redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeDeleteExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('bash'))
  })

  // ── grep ──

  it('passes through enabled native grep redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('grep')])
    const { execs, sentFrames } = runExec(makeGrepExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'grep',
      nativeResultType: 'grepResult',
    })
  })

  it('rejects disabled grep redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeGrepExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('grep'))
  })

  // ── ls ──

  it('passes through enabled native ls redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('ls')])
    const { execs, sentFrames } = runExec(makeLsExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'ls',
      nativeResultType: 'lsResult',
    })
  })

  it('rejects disabled ls redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeLsExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('ls'))
  })

  // ── fetch (maps to bash) ──

  it('passes through enabled native fetch redirect (maps to bash)', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('bash')])
    const { execs, sentFrames } = runExec(makeFetchExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'bash',
      nativeResultType: 'fetchResult',
    })
  })

  it('rejects disabled fetch redirect with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeFetchExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('bash'))
  })

  // ── shell (shellArgs) ──

  it('passes through enabled native shell redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('bash')])
    const { execs, sentFrames } = runExec(makeShellExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'bash',
      nativeResultType: 'shellResult',
    })
  })

  it('rejects disabled shell redirect with a native shell rejection', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeShellExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectShellRejected(sentFrames, TOOL_DISABLED_REASON('bash'))
  })

  // ── shellStream (shellStreamArgs) ──

  it('passes through enabled native shellStream redirect', () => {
    const enabledToolNames = buildEnabledToolSet([makeToolDefinition('bash')])
    const { execs, sentFrames } = runExec(makeShellStreamExecMessage(), enabledToolNames)

    expect(sentFrames).toHaveLength(0)
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      toolName: 'bash',
      nativeResultType: 'shellStreamResult',
    })
  })

  it('rejects disabled shellStream redirect with a native shell rejection', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeShellStreamExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectShellRejected(sentFrames, TOOL_DISABLED_REASON('bash'))
  })
})

// ── Interaction query rejection ──

describe('processServerMessage interaction query rejection', () => {
  it.each([
    ['webSearchRequestQuery', 'webSearchRequestResponse'],
    ['exaSearchRequestQuery', 'exaSearchRequestResponse'],
    ['exaFetchRequestQuery', 'exaFetchRequestResponse'],
  ] as const)('rejects %s queries (always rejected — no Pi tool equivalent)', (queryCase, responseCase) => {
    const sentFrames: Buffer[] = []
    const recognized = processServerMessage(makeInteractionMessage(queryCase), {
      blobStore: new Map(),
      mcpTools: [],
      enabledToolNames: buildEnabledToolSet([]),
      sendFrame: (data) => sentFrames.push(Buffer.from(data)),
      state: createStreamState(),
      onText: () => {},
      onMcpExec: () => {},
    })

    expect(recognized).toBeTruthy()
    expect(sentFrames).toHaveLength(1)

    const responseFrame = decodeClientFrame(sentFrames[0])
    const interactionResponse = getInteractionResponse(responseFrame)
    expect(interactionResponse.result.case).toBe(responseCase)
    if (interactionResponse.result.case !== responseCase) {
      throw new Error(`Expected ${responseCase}, got ${String(interactionResponse.result.case)}`)
    }

    const queryResponse = interactionResponse.result.value
    expect(queryResponse.result.case).toBe('rejected')
    if (queryResponse.result.case !== 'rejected') {
      throw new Error(`Expected rejected interaction query result, got ${String(queryResponse.result.case)}`)
    }

    expect(queryResponse.result.value.reason).toBe(
      'Tool not available in this environment. Use the MCP tools provided instead.',
    )
  })

  // Intentionally always rejected — no Pi tool maps to web/exa.
  // These interaction queries are Cursor-internal features, not MCP tools.
  it.each([
    ['webSearchRequestQuery', 'webSearchRequestResponse'],
    ['exaSearchRequestQuery', 'exaSearchRequestResponse'],
    ['exaFetchRequestQuery', 'exaFetchRequestResponse'],
  ] as const)('rejects %s even when tools are enabled (no bypass)', (queryCase, responseCase) => {
    const sentFrames: Buffer[] = []
    // Register many tools — queries should still be rejected
    const enabledToolNames = buildEnabledToolSet([
      makeToolDefinition('read'),
      makeToolDefinition('write'),
      makeToolDefinition('bash'),
      makeToolDefinition('grep'),
    ])
    const recognized = processServerMessage(makeInteractionMessage(queryCase), {
      blobStore: new Map(),
      mcpTools: [],
      enabledToolNames,
      sendFrame: (data) => sentFrames.push(Buffer.from(data)),
      state: createStreamState(),
      onText: () => {},
      onMcpExec: () => {},
    })

    expect(recognized).toBeTruthy()
    expect(sentFrames).toHaveLength(1)

    const responseFrame = decodeClientFrame(sentFrames[0])
    const interactionResponse = getInteractionResponse(responseFrame)
    expect(interactionResponse.result.case).toBe(responseCase)
    if (interactionResponse.result.case !== responseCase) {
      throw new Error(`Expected ${responseCase}, got ${String(interactionResponse.result.case)}`)
    }

    const queryResponse = interactionResponse.result.value
    expect(queryResponse.result.case).toBe('rejected')
  })
})
