import { randomUUID } from 'node:crypto'
/**
 * Proxy HTTP server — main entry point.
 *
 * Reads config from stdin, discovers models, starts an HTTP server on
 * an ephemeral port, and writes a ready signal to stdout.  Routes:
 *
 *   GET  /v1/models            → OpenAI-format model list
 *   POST /v1/chat/completions  → chat completion (SSE or non-streaming)
 *   /internal/*                → delegate to internal-api
 *   *                          → 404
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { create, fromBinary, fromJson, toBinary } from '@bufbuild/protobuf'
import type { JsonValue } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'

import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  McpToolDefinitionSchema,
  type McpToolDefinition,
  ModelDetailsSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from '../proto/agent_pb.ts'
import {
  getConversationState,
  persistConversation,
  resolveConversationState,
  type ConversationConfig,
} from './conversation-state.ts'
import { CursorSession, type SessionOptions } from './cursor-session.ts'
import {
  configureInternalApi,
  getAccessToken,
  getCachedModels,
  handleInternalRequest,
  startHeartbeatMonitor,
} from './internal-api.ts'
import { discoverCursorModels, type CursorModel } from './models.ts'
import { MCP_TOOL_PREFIX } from './native-tools.ts'
import { type OpenAIMessage, type OpenAIToolDef, parseMessages, selectToolsForChoice } from './openai-messages.ts'
import {
  collectNonStreamingResponse,
  createSSECtx,
  type PumpResult,
  pumpSession,
  SSE_HEADERS,
} from './openai-stream.ts'
import { buildRequestContext } from './request-context.ts'
import {
  closeAllSessions,
  deriveConversationKey,
  deriveSessionKey,
  evictStaleSessions,
  getActiveSession,
  removeActiveSession,
  setActiveSession,
} from './session-manager.ts'

// ── Types ──

interface ProxyConfig {
  accessToken: string
  conversationDir?: string
}

interface ChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: OpenAIToolDef[]
  tool_choice?: string | { type: string; function: { name: string } }
}

// ── Helpers ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function errorResponse(res: ServerResponse, status: number, message: string, code = 'server_error'): void {
  jsonResponse(res, status, { error: { message, type: 'server_error', code } })
}

function isChatCompletionRequest(value: unknown): value is ChatCompletionRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const req = value as { model?: unknown; messages?: unknown }
  return (
    typeof req.model === 'string' &&
    Array.isArray(req.messages) &&
    req.messages.every(
      (m: unknown) => m !== null && typeof m === 'object' && typeof (m as { role?: unknown }).role === 'string',
    )
  )
}

// ── MCP tool conversion ──

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const { function: fn } = t
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === 'object'
        ? (fn.parameters as JsonValue)
        : ({ type: 'object', properties: {}, required: [] } as JsonValue)
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema))
    return create(McpToolDefinitionSchema, {
      name: `${MCP_TOOL_PREFIX}${fn.name}`,
      description: fn.description ?? '',
      providerIdentifier: 'pi',
      toolName: fn.name,
      inputSchema,
    })
  })
}

// ── Checkpoint decode ──

function decodeCheckpointState(
  checkpoint: Uint8Array,
): ReturnType<typeof create<typeof ConversationStateStructureSchema>> | null {
  try {
    return fromBinary(ConversationStateStructureSchema, checkpoint)
  } catch {
    console.error('[proxy] Ignoring invalid stored checkpoint')
    return null
  }
}

// ── AgentRunRequest building ──

function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: { userText: string; assistantText: string }[],
  conversationId: string,
  checkpoint: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
): { requestBytes: Uint8Array; blobStore: Map<string, Uint8Array>; mcpTools: McpToolDefinition[] } {
  // Try decoding a persisted checkpoint
  const decodedCheckpoint = checkpoint ? decodeCheckpointState(checkpoint) : null

  let conversationState: ReturnType<typeof create<typeof ConversationStateStructureSchema>>
  if (decodedCheckpoint) {
    conversationState = decodedCheckpoint
  } else {
    // Build turns from scratch
    const turnBytes: Uint8Array[] = []
    for (const turn of turns) {
      const userMsg = create(UserMessageSchema, {
        text: turn.userText,
        messageId: randomUUID(),
      })
      const userMsgBytes = toBinary(UserMessageSchema, userMsg)

      const stepBytes: Uint8Array[] = []
      if (turn.assistantText) {
        const step = create(ConversationStepSchema, {
          message: {
            case: 'assistantMessage',
            value: create(AssistantMessageSchema, { text: turn.assistantText }),
          },
        })
        stepBytes.push(toBinary(ConversationStepSchema, step))
      }

      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: userMsgBytes,
        steps: stepBytes,
      })
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: { case: 'agentConversationTurn', value: agentTurn },
      })
      turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure))
    }
    conversationState = create(ConversationStateStructureSchema, { turns: turnBytes })
  }

  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: randomUUID(),
  })
  const requestContext = buildRequestContext(mcpTools, systemPrompt || undefined)
  const action = create(ConversationActionSchema, {
    action: {
      case: 'userMessageAction',
      value: create(UserMessageActionSchema, { userMessage, requestContext }),
    },
  })

  // Enable max mode for models that support it.
  // The cached model list carries supportsMaxMode from discovery.
  const cachedModel = getCachedModels().find((m) => m.id === modelId)
  const maxMode = cachedModel?.supportsMaxMode ?? false

  const modelDetails = create(ModelDetailsSchema, {
    modelId,
    displayModelId: modelId,
    displayName: modelId,
    displayNameShort: modelId,
    maxMode,
  })

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    conversationId,
  })

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'runRequest', value: runRequest },
  })

  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools,
  }
}

// buildResumeRequest is reserved for future checkpoint resume functionality.
// It requires conversationId, checkpoint, mcpTools, and cloudRule parameters.

// ── Models endpoint ──

function handleModelsRequest(res: ServerResponse, models: CursorModel[]): void {
  const data = models.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cursor',
  }))
  jsonResponse(res, 200, { object: 'list', data })
}

// ── Chat completion ──

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  convConfig: ConversationConfig,
): Promise<void> {
  const accessToken = getAccessToken()
  if (!accessToken) {
    errorResponse(res, 401, 'No access token configured')
    return
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    errorResponse(res, 400, 'Invalid JSON body')
    return
  }

  if (!isChatCompletionRequest(body)) {
    errorResponse(res, 400, 'Invalid chat completion request: model and messages required')
    return
  }

  const { model: modelId, messages, stream = true, tools = [], tool_choice } = body
  const sessionId = (req.headers['x-session-id'] as string | undefined) ?? 'default'
  const sessionKey = deriveSessionKey(sessionId, messages)
  const convKey = deriveConversationKey(sessionId, messages)

  const { systemPrompt, turns, userText, toolResults } = parseMessages(messages)
  const selectedTools = selectToolsForChoice(tools, tool_choice)
  const mcpTools = buildMcpToolDefinitions(selectedTools)

  // ── Tool-result resume (session still alive) ──
  if (toolResults.length > 0) {
    const existingSession = getActiveSession(sessionKey)
    if (existingSession?.alive) {
      const newResults = toolResults.map((r) => ({
        toolCallId: r.toolCallId,
        content: r.content,
        isError: false,
      }))
      existingSession.sendToolResults(newResults)

      if (stream) {
        const completionId = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 28)}`
        const created = Math.floor(Date.now() / 1000)
        const readableStream = new ReadableStream({
          start(controller) {
            const ctx = createSSECtx(controller, modelId, completionId, created)
            void pumpAndFinalize(existingSession, ctx, sessionKey, convKey, convConfig)
          },
        })
        res.writeHead(200, SSE_HEADERS)
        const reader = readableStream.getReader() as ReadableStreamDefaultReader<Uint8Array>
        void pipeReaderToResponse(reader, res)
      } else {
        const response = await collectNonStreamingResponse(existingSession, modelId)
        removeActiveSession(sessionKey)
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        res.end(await response.text())
      }
      return
    }
    // Session is gone — fall through to fresh request
    removeActiveSession(sessionKey)
  }

  // ── Fresh request ──
  const stored = resolveConversationState(convKey, convConfig)
  const effectiveUserText = userText || (toolResults.length > 0 ? toolResults.map((r) => r.content).join('\n') : '')
  const payload = buildCursorRequest(
    modelId,
    systemPrompt,
    effectiveUserText,
    turns,
    stored.conversationId,
    stored.checkpoint,
    stored.blobStore,
    mcpTools,
  )

  const sessionOptions: SessionOptions = {
    accessToken,
    requestBytes: payload.requestBytes,
    blobStore: payload.blobStore,
    mcpTools,
    cloudRule: systemPrompt || undefined,
    convKey,
    onCheckpoint: (checkpointBytes, blobStoreRef) => {
      stored.checkpoint = checkpointBytes
      // Sync blob store reference
      for (const [k, v] of blobStoreRef) {
        stored.blobStore.set(k, v)
      }
      persistConversation(convKey, stored, convConfig)
    },
  }

  const session = new CursorSession(sessionOptions)

  if (stream) {
    const completionId = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 28)}`
    const created = Math.floor(Date.now() / 1000)
    const readableStream = new ReadableStream({
      start(controller) {
        const ctx = createSSECtx(controller, modelId, completionId, created)
        void pumpAndFinalize(session, ctx, sessionKey, convKey, convConfig)
      },
    })
    res.writeHead(200, SSE_HEADERS)
    const reader = readableStream.getReader() as ReadableStreamDefaultReader<Uint8Array>
    void pipeReaderToResponse(reader, res)
  } else {
    const response = await collectNonStreamingResponse(session, modelId)
    persistConversation(convKey, stored, convConfig)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  }
}

/**
 * Pump a session and handle batchReady (keep session alive for tool-result
 * continuation) or done (clean up).
 */
async function pumpAndFinalize(
  session: CursorSession,
  ctx: ReturnType<typeof createSSECtx>,
  sessionKey: string,
  convKey: string,
  convConfig: ConversationConfig,
): Promise<void> {
  try {
    const result: PumpResult = await pumpSession(session, ctx)

    if (result.outcome === 'batchReady') {
      // Keep session alive for tool-result continuation
      setActiveSession(sessionKey, session)
    } else {
      // Done or retry — persist conversation state and clean up
      const stored = getConversationState(convKey)
      if (stored) {
        persistConversation(convKey, stored, convConfig)
      }
      removeActiveSession(sessionKey)
      session.close()
    }
  } catch (error) {
    console.error('[proxy] pumpSession error:', error)
    removeActiveSession(sessionKey)
    session.close()
    ctx.close()
  }
}

/**
 * Pipe a ReadableStream reader into a Node.js ServerResponse.
 */
async function pipeReaderToResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!res.writableEnded) {
        res.write(value)
      }
    }
  } catch {
    /* client disconnect */
  } finally {
    if (!res.writableEnded) {
      res.end()
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  // 1. Read config from stdin
  const rl = createInterface({ input: process.stdin })
  const configLine = await new Promise<string>((resolve) => {
    rl.once('line', resolve)
  })
  rl.close()

  let config: ProxyConfig
  try {
    config = JSON.parse(configLine) as ProxyConfig
  } catch {
    console.error('[proxy] Invalid JSON config on stdin')
    process.exit(1)
  }

  if (!config.accessToken) {
    console.error('[proxy] accessToken is required')
    process.exit(1)
  }

  const convConfig: ConversationConfig = {
    conversationDiskDir: config.conversationDir ?? join(tmpdir(), 'pi-cursor-conversations'),
  }

  // 2. Configure internal API
  configureInternalApi({
    initialToken: config.accessToken,
    initialModels: [],
    onShutdown: () => {
      console.error('[proxy] Shutdown requested')
      closeAllSessions()
      process.exit(0)
    },
  })

  // 3. Discover models
  let models: CursorModel[] = []
  try {
    models = await discoverCursorModels(config.accessToken)
    console.error(`[proxy] Discovered ${String(models.length)} models`)
  } catch (error) {
    console.error('[proxy] Model discovery failed:', error)
  }

  // Update internal API with discovered models
  configureInternalApi({
    initialToken: config.accessToken,
    initialModels: models,
    onShutdown: () => {
      console.error('[proxy] Shutdown requested')
      closeAllSessions()
      process.exit(0)
    },
  })

  // 4. Start HTTP server
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (url.pathname.startsWith('/internal/')) {
      void handleInternalRequest(req, res, url.pathname)
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      handleModelsRequest(res, getCachedModels())
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      void handleChatCompletion(req, res, convConfig).catch((error) => {
        console.error('[proxy] Chat completion error:', error)
        if (!res.headersSent) {
          errorResponse(res, 500, 'Internal server error')
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  })

  // 5. Start periodic session eviction
  const evictionTimer = setInterval(() => {
    evictStaleSessions()
  }, 60_000)
  if (typeof evictionTimer === 'object' && 'unref' in evictionTimer) {
    evictionTimer.unref()
  }

  server.listen(0, () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0

    // 6. Write ready signal to stdout (extension reads this)
    const readySignal = JSON.stringify({
      type: 'ready',
      port,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImages: m.supportsImages,
      })),
    })
    console.log(readySignal)

    // 7. Start heartbeat monitor
    startHeartbeatMonitor()

    console.error(`[proxy] Listening on port ${String(port)}`)
  })
}

main().catch((error) => {
  console.error('[proxy] Fatal:', error)
  process.exit(1)
})
