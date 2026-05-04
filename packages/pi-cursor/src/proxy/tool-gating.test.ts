import { create, fromBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
  InteractionQuerySchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WebSearchArgsSchema,
  WebSearchRequestQuerySchema,
} from '../proto/agent_pb.ts'
import { createStreamState, handleExecMessage, processServerMessage, type PendingExec } from './cursor-messages.ts'
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

function runExec(execMsg: ReturnType<typeof makeMcpExecMessage>, enabledToolNames: Set<string>) {
  const sentFrames: Buffer[] = []
  const execs: PendingExec[] = []

  handleExecMessage(
    execMsg,
    [],
    enabledToolNames,
    undefined,
    (data) => sentFrames.push(Buffer.from(data)),
    (exec) => execs.push(exec),
    createStreamState(),
  )

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

function expectShellRejected(sentFrames: Buffer[], expectedReason: string) {
  expect(sentFrames).toHaveLength(2)

  const resultFrame = decodeClientFrame(sentFrames[0])
  const shellResult = getShellResult(resultFrame)
  expect(shellResult.result.case).toBe('rejected')
  if (shellResult.result.case !== 'rejected') {
    throw new Error(`Expected rejected shell result, got ${String(shellResult.result.case)}`)
  }

  const rejected = shellResult.result.value
  expect(rejected.command).toBe('pwd')
  expect(rejected.reason).toBe(expectedReason)

  const closeFrame = decodeClientFrame(sentFrames[1])
  expect(closeFrame.message.case).toBe('execClientControlMessage')
}

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
})

describe('handleExecMessage native redirect gating', () => {
  it('passes through enabled native redirects', () => {
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

  it('rejects disabled redirected file tools with an MCP error result', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeReadExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectMcpError(sentFrames, TOOL_DISABLED_REASON('read'))
  })

  it('rejects disabled redirected shell tools with a native shell rejection', () => {
    const enabledToolNames = buildEnabledToolSet([])
    const { execs, sentFrames } = runExec(makeShellExecMessage(), enabledToolNames)

    expect(execs).toHaveLength(0)
    expectShellRejected(sentFrames, TOOL_DISABLED_REASON('bash'))
  })
})

describe('processServerMessage interaction query rejection', () => {
  it.each([
    ['webSearchRequestQuery', 'webSearchRequestResponse'],
    ['exaSearchRequestQuery', 'exaSearchRequestResponse'],
    ['exaFetchRequestQuery', 'exaFetchRequestResponse'],
  ] as const)('rejects %s queries', (queryCase, responseCase) => {
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
})
