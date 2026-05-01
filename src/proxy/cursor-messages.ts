/**
 * Handlers for Cursor server messages (AgentServerMessage).
 *
 * Processes interactionUpdate (text/thinking deltas, tool lifecycle),
 * execServerMessage (tool calls, request context), kvServerMessage (blobs),
 * interactionQuery (web search, questions), and checkpoints.
 *
 * This module is fundamentally protobuf dispatch code — it pattern-matches on
 * discriminated unions from `@bufbuild/protobuf`. The library's generated types
 * use `any` in union positions, making `no-unsafe-*` rules fire on nearly every
 * line. These are intentional and safe; we suppress them at file level.
 */
/* oxlint-disable typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-argument */
import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'

import {
  AgentClientMessageSchema,
  type AgentServerMessage,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  BackgroundShellSpawnResultSchema,
  ConversationStateStructureSchema,
  CreatePlanRequestResponseSchema,
  DiagnosticsResultSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponseSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  type ExecServerMessage,
  GetBlobResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  type KvServerMessage,
  type McpToolDefinition,
  RequestContextResultSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  SwitchModeRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
} from '../proto/agent_pb.ts'
import { frameConnectMessage } from './connect-protocol.ts'
import { classifyExecMessage, fixMcpArgNames, stripMcpToolPrefix } from './native-tools.ts'
import { buildRequestContext } from './request-context.ts'

export interface StreamState {
  toolCallIndex: number
  /** Total exec round-trips (MCP + native rejects + requestContext). Tracks Cursor's 25-call limit. */
  totalExecCount: number
  pendingExecs: PendingExec[]
  outputTokens: number
  totalTokens: number
  /** Set when the server sends an endStream frame (clean close or error). */
  endStreamSeen: boolean
  /** Set by batch-complete signals (checkpoint, stepCompleted, turnEnded)
   *  to indicate pending execs should be flushed.
   *  NOT set by toolCallStarted, requestContextArgs, or heartbeat. */
  checkpointAfterExec: boolean
  /** Tracks last delta type for debug logging transitions. */
  lastDeltaType: string | null
}

export interface PendingExec {
  execId: string
  execMsgId: number
  toolCallId: string
  toolName: string
  /** Decoded arguments JSON string for SSE tool_calls emission. */
  decodedArgs: string
  /** Set when this exec originated from a native Cursor tool redirected to MCP. */
  nativeResultType?: NativeResultType
  /** Original native args needed for result construction (e.g., path, url). */
  nativeArgs?: Record<string, string>
}

export type NativeResultType =
  | 'readResult'
  | 'writeResult'
  | 'deleteResult'
  | 'fetchResult'
  | 'shellResult'
  | 'shellStreamResult'
  | 'lsResult'
  | 'grepResult'

export function createStreamState(): StreamState {
  return {
    toolCallIndex: 0,
    totalExecCount: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    endStreamSeen: false,
    checkpointAfterExec: false,
    lastDeltaType: null,
  }
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value)
    return toJson(ValueSchema, parsed)
  } catch {
    // Fallback to text decoding
  }
  return new TextDecoder().decode(value)
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value)
  }
  return decoded
}

interface NativeRedirectInfo {
  toolCallId: string
  toolName: string
  decodedArgs: string
  nativeResultType: NativeResultType
  nativeArgs: Record<string, string>
}

function nativeToMcpRedirect(execCase: string, execMsg: ExecServerMessage): NativeRedirectInfo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = execMsg.message.value as any
  const toolCallId: string = (args?.toolCallId as string) || crypto.randomUUID()

  if (execCase === 'readArgs') {
    const mcpArgs: Record<string, unknown> = { filePath: args.path }
    if (args.offset !== null && args.offset !== undefined && args.offset !== 0) {
      mcpArgs.offset = args.offset
    }
    if (args.limit !== null && args.limit !== undefined && args.limit !== 0) {
      mcpArgs.limit = args.limit
    }
    return {
      toolCallId,
      toolName: 'read',
      decodedArgs: JSON.stringify(mcpArgs),
      nativeResultType: 'readResult',
      nativeArgs: { path: String(args.path ?? '') },
    }
  }

  if (execCase === 'writeArgs') {
    const fileContent =
      args.fileBytes?.length > 0 ? new TextDecoder().decode(args.fileBytes) : String(args.fileText ?? '')
    return {
      toolCallId,
      toolName: 'write',
      decodedArgs: JSON.stringify({ filePath: args.path, content: fileContent }),
      nativeResultType: 'writeResult',
      nativeArgs: { path: String(args.path ?? '') },
    }
  }

  if (execCase === 'deleteArgs') {
    const rawPath = String(args.path ?? '')
    if (!rawPath) {
      return {
        toolCallId,
        toolName: 'bash',
        decodedArgs: JSON.stringify({ command: 'true', description: 'No-op delete (empty path)' }),
        nativeResultType: 'deleteResult',
        nativeArgs: { path: '' },
      }
    }
    const safePath = rawPath.replaceAll('\0', '').replaceAll("'", "'\\''")
    return {
      toolCallId,
      toolName: 'bash',
      decodedArgs: JSON.stringify({ command: `rm -f '${safePath}'`, description: `Delete ${rawPath}` }),
      nativeResultType: 'deleteResult',
      nativeArgs: { path: rawPath },
    }
  }

  if (execCase === 'shellArgs' || execCase === 'shellStreamArgs') {
    const command = String(args.command ?? '')
    const resultType: NativeResultType = execCase === 'shellStreamArgs' ? 'shellStreamResult' : 'shellResult'
    return {
      toolCallId,
      toolName: 'bash',
      decodedArgs: JSON.stringify({ command }),
      nativeResultType: resultType,
      nativeArgs: { command },
    }
  }

  if (execCase === 'grepArgs') {
    const pattern = String(args.pattern ?? '')
    const path = String(args.path ?? '.')
    return {
      toolCallId,
      toolName: 'grep',
      decodedArgs: JSON.stringify({ pattern, path }),
      nativeResultType: 'grepResult',
      nativeArgs: { pattern, path },
    }
  }

  if (execCase === 'lsArgs') {
    const path = String(args.path ?? '.')
    return {
      toolCallId,
      toolName: 'glob',
      decodedArgs: JSON.stringify({ pattern: `${path}/**` }),
      nativeResultType: 'lsResult',
      nativeArgs: { path },
    }
  }

  if (execCase === 'fetchArgs') {
    const url = String(args.url ?? '')
    return {
      toolCallId,
      toolName: 'bash',
      decodedArgs: JSON.stringify({ command: `curl -sL '${url}'`, description: `Fetch ${url}` }),
      nativeResultType: 'fetchResult',
      nativeArgs: { url },
    }
  }

  return null
}

function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Buffer) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    message: { case: messageCase as any, value: value as any },
  })
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: 'kvClientMessage', value: response },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)))
}

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Buffer) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    message: { case: messageCase as any, value: value as any },
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClientMessage },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
  sendExecStreamClose(execMsg.id, sendFrame)
}

function sendExecStreamClose(execId: number, sendFrame: (data: Buffer) => void): void {
  const controlMsg = create(ExecClientControlMessageSchema, {
    message: {
      case: 'streamClose',
      value: create(ExecClientStreamCloseSchema, { id: execId }),
    },
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientControlMessage', value: controlMsg },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

/**
 * Send a best-effort empty result for an exec type not in our proto schema.
 * Extracts the unknown oneof field number from $unknown and mirrors it back
 * as an empty message on the ExecClientMessage, preventing the server from
 * waiting indefinitely.
 */
function sendUnknownExecResult(execMsg: ExecServerMessage, sendFrame: (data: Buffer) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unknowns: { no: number; wireType: number; data: Uint8Array }[] | undefined = (execMsg as any).$unknown
  const argsField = unknowns?.find((f) => f.wireType === 2 && f.no !== 1 && f.no !== 15 && f.no !== 19)
  if (!argsField) {
    console.error('[cursor-messages] unhandled exec: no recoverable field number', {
      case: execMsg.message.case,
      id: execMsg.id,
    })
    return
  }
  const resultFieldNo = argsField.no
  console.error('[cursor-messages] unhandled exec: sending empty result', { field: resultFieldNo, id: execMsg.id })
  const execClientMsg = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(execClientMsg as any).$unknown = [{ no: resultFieldNo, wireType: 2, data: new Uint8Array(0) }]
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClientMsg },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
  sendExecStreamClose(execMsg.id, sendFrame)
}

function handleInteractionUpdate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: any,
  state: StreamState,
  onText: (text: string, isThinking: boolean) => void,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const updateCase: string | undefined = update.message?.case

  if (updateCase === 'textDelta') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const delta: string = (update.message.value.text as string) || ''
    if (delta) {
      state.lastDeltaType = 'text'
      onText(delta, false)
    }
  } else if (updateCase === 'thinkingDelta') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const delta: string = (update.message.value.text as string) || ''
    if (delta) {
      state.lastDeltaType = 'thinking'
      onText(delta, true)
    }
  } else if (updateCase === 'tokenDelta') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    state.outputTokens += (update.message.value.tokens as number) || 0
  } else if (updateCase === 'toolCallStarted') {
    // Just a notification — not a batch delimiter
  } else if (updateCase === 'toolCallCompleted') {
    // Notification only
  } else if (updateCase === 'turnEnded') {
    if (state.pendingExecs.length > 0) {
      state.checkpointAfterExec = true
    }
  } else if (updateCase === 'stepCompleted') {
    if (state.pendingExecs.length > 0) {
      state.checkpointAfterExec = true
    }
  } else if (updateCase === 'heartbeat') {
    // keepalive — not a batch delimiter
  }
  // Ignore: toolCallDelta, partialToolCall, and other unrecognized types
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Buffer) => void,
): void {
  const kvCase = kvMsg.message.case

  if (kvCase === 'getBlobArgs') {
    const { blobId } = kvMsg.message.value
    const blobIdKey = Buffer.from(blobId).toString('hex')
    const blobData = blobStore.get(blobIdKey)
    sendKvResponse(kvMsg, 'getBlobResult', create(GetBlobResultSchema, blobData ? { blobData } : {}), sendFrame)
  } else if (kvCase === 'setBlobArgs') {
    const { blobId, blobData } = kvMsg.message.value
    blobStore.set(Buffer.from(blobId).toString('hex'), blobData)
    sendKvResponse(kvMsg, 'setBlobResult', create(SetBlobResultSchema, {}), sendFrame)
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Buffer) => void,
  onMcpExec: (exec: PendingExec) => void,
  state?: StreamState,
): void {
  const execCase = execMsg.message.case

  // MCP tool calls — decode args and pass through
  if (execCase === 'mcpArgs') {
    if (state) {
      state.totalExecCount++
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpArgs = execMsg.message.value as any
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const decoded = decodeMcpArgsMap(mcpArgs.args as Record<string, Uint8Array>)
    const resolvedToolName = stripMcpToolPrefix((mcpArgs.toolName as string) || (mcpArgs.name as string) || '')
    fixMcpArgNames(resolvedToolName, decoded)
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: (mcpArgs.toolCallId as string) || crypto.randomUUID(),
      toolName: resolvedToolName,
      decodedArgs: JSON.stringify(decoded),
    })
    return
  }

  // RequestContext — respond inline with MCP tools and cloud rule
  if (execCase === 'requestContextArgs') {
    const requestContext = buildRequestContext(mcpTools, cloudRule)
    const result = create(RequestContextResultSchema, {
      result: {
        case: 'success',
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    })
    sendExecResult(execMsg, 'requestContextResult', result, sendFrame)
    return
  }

  // --- Redirect supported native tools through Pi MCP ---
  const classification = classifyExecMessage(execCase ?? '')

  if (classification === 'redirect') {
    if (state) {
      state.totalExecCount++
    }
    const nativeRedirect = nativeToMcpRedirect(execCase as string, execMsg)
    if (nativeRedirect) {
      onMcpExec({
        execId: execMsg.execId,
        execMsgId: execMsg.id,
        toolCallId: nativeRedirect.toolCallId,
        toolName: nativeRedirect.toolName,
        decodedArgs: nativeRedirect.decodedArgs,
        nativeResultType: nativeRedirect.nativeResultType,
        nativeArgs: nativeRedirect.nativeArgs,
      })
      return
    }
  }

  // --- Reject unsupported native tools ---
  const REJECT_REASON = 'Tool not available in this environment. Use the MCP tools provided instead.'

  if (execCase === 'backgroundShellSpawnArgs') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = execMsg.message.value as any
    const result = create(BackgroundShellSpawnResultSchema, {
      result: {
        case: 'rejected',
        value: create(ShellRejectedSchema, {
          command: (args.command as string) || '',
          workingDirectory: (args.workingDirectory as string) || '',
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    })
    sendExecResult(execMsg, 'backgroundShellSpawnResult', result, sendFrame)
    return
  }

  if (execCase === 'writeShellStdinArgs') {
    const result = create(WriteShellStdinResultSchema, {
      result: {
        case: 'error',
        value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }),
      },
    })
    sendExecResult(execMsg, 'writeShellStdinResult', result, sendFrame)
    return
  }

  if (execCase === 'diagnosticsArgs') {
    const result = create(DiagnosticsResultSchema, {})
    sendExecResult(execMsg, 'diagnosticsResult', result, sendFrame)
    return
  }

  // Unknown exec type — try to send an empty result to avoid server hanging
  if (state) {
    state.totalExecCount++
  }
  sendUnknownExecResult(execMsg, sendFrame)
}

function handleInteractionQuery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  sendFrame: (data: Buffer) => void,
  onNotify?: (text: string) => void,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const queryId: number = (query.id as number) || 0
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const queryCase: string = (query.query?.case as string) || 'unknown'
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const searchTerm: string =
    queryCase === 'webSearchRequestQuery' ? (query.query?.value?.args?.searchTerm as string) || '' : ''

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseResult: { case: string; value: unknown } | undefined

  if (queryCase === 'webSearchRequestQuery') {
    if (onNotify && searchTerm) {
      onNotify(`[web search: ${searchTerm}]`)
    }
    responseResult = {
      case: 'webSearchRequestResponse',
      value: create(WebSearchRequestResponseSchema, {
        result: { case: 'approved', value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
      }),
    }
  } else if (queryCase === 'exaSearchRequestQuery') {
    responseResult = {
      case: 'exaSearchRequestResponse',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: create(ExaSearchRequestResponseSchema, { result: { case: 'approved', value: {} as any } }),
    }
  } else if (queryCase === 'exaFetchRequestQuery') {
    responseResult = {
      case: 'exaFetchRequestResponse',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: create(ExaFetchRequestResponseSchema, { result: { case: 'approved', value: {} as any } }),
    }
  } else if (queryCase === 'askQuestionInteractionQuery') {
    responseResult = {
      case: 'askQuestionInteractionResponse',
      value: create(AskQuestionInteractionResponseSchema, {
        result: create(AskQuestionResultSchema, {
          result: { case: 'rejected', value: create(AskQuestionRejectedSchema, {}) },
        }),
      }),
    }
  } else if (queryCase === 'switchModeRequestQuery') {
    responseResult = {
      case: 'switchModeRequestResponse',
      value: create(SwitchModeRequestResponseSchema, {}),
    }
  } else if (queryCase === 'createPlanRequestQuery') {
    responseResult = {
      case: 'createPlanRequestResponse',
      value: create(CreatePlanRequestResponseSchema, {}),
    }
  } else {
    // Unknown query type — send empty interaction response
    console.error(
      `[cursor-messages] interactionQuery: unknown type ${queryCase} -- sending empty response for id=${String(queryId)}`,
    )
  }

  // Build and send the interaction response
  const interactionResponse = create(InteractionResponseSchema, {
    id: queryId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: responseResult ? ({ case: responseResult.case, value: responseResult.value } as any) : undefined,
  })
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: 'interactionResponse', value: interactionResponse },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)))
}

/** Returns true if the message was a recognized type (real server activity, not keepalive). */
export function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Buffer) => void,
  state: StreamState,
  onText: (text: string, isThinking: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  onNotify?: (text: string) => void,
): boolean {
  const msgCase = msg.message.case

  if (msgCase === 'interactionUpdate') {
    handleInteractionUpdate(msg.message.value, state, onText)
    return true
  }

  if (msgCase === 'kvServerMessage') {
    handleKvMessage(msg.message.value, blobStore, sendFrame)
    return true
  }

  if (msgCase === 'execServerMessage') {
    handleExecMessage(msg.message.value, mcpTools, cloudRule, sendFrame, onMcpExec, state)
    return true
  }

  if (msgCase === 'conversationCheckpointUpdate') {
    const stateStructure = msg.message.value
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure))
    }
    return true
  }

  if (msgCase === 'execServerControlMessage') {
    const ctrl = msg.message.value
    if (ctrl.message.case === 'abort') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`[cursor-messages] exec ABORT for id=${String((ctrl.message.value as any).id)}`)
    }
    return true
  }

  if (msgCase === 'interactionQuery') {
    handleInteractionQuery(msg.message.value, sendFrame, onNotify)
    return true
  }

  console.error(`[cursor-messages] unrecognized server message case: ${String(msgCase)}`)
  return false
}
