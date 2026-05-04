import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
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
import { homedir, tmpdir } from 'node:os'
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
import { resolveEffective, type NativeToolsMode } from './config.ts'
import {
  computeLineageFingerprint,
  getConversationState,
  persistConversation,
  resolveConversationState,
  validateLineage,
  type ConversationConfig,
  type LineageMetadata,
  evictStaleConversations,
} from './conversation-state.ts'
import { CursorSession, type RetryHint, type SessionOptions } from './cursor-session.ts'
import {
  debugRequestId,
  logCheckpointCommit,
  logRequestEnd,
  logRequestStart,
  logSessionCreate,
  logSessionResume,
} from './debug-logger.ts'
import { jsonResponse, readBody } from './http-helpers.ts'
import {
  configureInternalApi,
  getAccessToken,
  getCachedModels,
  handleInternalRequest,
  startHeartbeatMonitor,
} from './internal-api.ts'
import { processModels, resolveModelId, type NormalizedModelSet } from './model-normalization.ts'
import { discoverCursorModels, type CursorModel } from './models.ts'
import { MCP_TOOL_PREFIX, resolveAllowedRoot } from './native-tools.ts'
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

// ── Retry helpers ──

/** Delay (ms) before retrying based on the failure hint. */
function retryDelayMs(hint: RetryHint): number {
  switch (hint) {
    case 'blob_not_found': {
      return 200
    }
    case 'resource_exhausted': {
      return 2000
    }
    case 'timeout': {
      return 1000
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: { userText: string; assistantText: string }[],
  conversationId: string,
  checkpoint: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  nativeToolsMode: NativeToolsMode = 'reject',
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
  const requestContext = buildRequestContext(mcpTools, systemPrompt || undefined, nativeToolsMode)
  const action = create(ConversationActionSchema, {
    action: {
      case: 'userMessageAction',
      value: create(UserMessageActionSchema, { userMessage, requestContext }),
    },
  })

  // Max mode is determined by the model ID: -max suffix models get maxMode=true.
  // The actual model ID sent to Cursor strips the -max suffix.
  const isMaxMode = modelId.endsWith('-max')
  const cursorModelId = isMaxMode ? modelId.slice(0, -4) : modelId

  const modelDetails = create(ModelDetailsSchema, {
    modelId: cursorModelId,
    displayModelId: cursorModelId,
    displayName: cursorModelId,
    displayNameShort: cursorModelId,
    maxMode: isMaxMode,
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

/** Cached normalized model set, rebuilt on model discovery */
let cachedNormalizedSet: NormalizedModelSet | null = null

/** Get or build the normalized model set from the current raw models */
function getNormalizedModelSet(): NormalizedModelSet {
  cachedNormalizedSet ??= processModels(getCachedModels())
  return cachedNormalizedSet
}

/** Call when raw models change (discovery, refresh) to invalidate cached normalization */
export function invalidateNormalizedModels(): void {
  cachedNormalizedSet = null
}

function handleModelsRequest(res: ServerResponse, models: CursorModel[]): void {
  const cfg = resolveEffective()
  const effectiveModels = cfg.modelMappings === 'normalized' ? getNormalizedModelSet().models : models

  const data = effectiveModels.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cursor',
  }))
  jsonResponse(res, 200, { object: 'list', data })
}

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

  const { model: requestedModelId, messages, stream = true, tools = [], tool_choice } = body

  // Resolve the final Cursor model ID when normalization is active
  const cfg = resolveEffective()
  let modelId: string
  if (cfg.modelMappings === 'normalized') {
    const modelSet = getNormalizedModelSet()
    // Extract Pi's reasoning-effort from the request body (injected by Pi)
    const bodyObj = body as unknown as Record<string, unknown>
    const effort = typeof bodyObj.reasoning_effort === 'string' ? bodyObj.reasoning_effort : null
    modelId = resolveModelId(requestedModelId, effort, cfg.maxMode, modelSet)
  } else {
    modelId = requestedModelId
  }

  // Prefer pi_session_id from body (injected by before_provider_request), fall back to header
  const bodyRecord = body as unknown as Record<string, unknown>
  const sessionId =
    (typeof bodyRecord.pi_session_id === 'string' ? bodyRecord.pi_session_id : undefined) ??
    (req.headers['x-session-id'] as string | undefined) ??
    'default'
  const piCwd = typeof bodyRecord.pi_cwd === 'string' ? bodyRecord.pi_cwd : undefined
  const sessionKey = deriveSessionKey(sessionId)
  const convKey = deriveConversationKey(sessionId)
  const requestId = debugRequestId()
  const requestStartTime = Date.now()

  logRequestStart(sessionId, requestId, {
    model: modelId,
    messageCount: messages.length,
    toolsCount: tools.length,
  })

  const { systemPrompt, turns, userText, toolResults } = parseMessages(messages)
  const selectedTools = selectToolsForChoice(tools, tool_choice)
  const mcpTools = buildMcpToolDefinitions(selectedTools)

  // ── Tool-result resume (session still alive) ──
  if (toolResults.length > 0) {
    const existingSession = getActiveSession(sessionKey)
    if (existingSession?.alive) {
      logSessionResume(sessionId, requestId, { sessionKey })
      const newResults = toolResults.map((r) => ({
        toolCallId: r.toolCallId,
        content: r.content,
        isError: false,
      }))
      existingSession.sendToolResults(newResults)

      // Cancel on client disconnect during tool-result continuation
      req.on('close', () => {
        if (existingSession.alive) {
          existingSession.cancel()
        }
      })

      const toolLineageInfo: LineageInfo = { turns, userText }

      if (stream) {
        const completionId = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 28)}`
        const created = Math.floor(Date.now() / 1000)
        const readableStream = new ReadableStream({
          start(controller) {
            const ctx = createSSECtx(controller, modelId, completionId, created)
            void pumpAndFinalize(existingSession, ctx, sessionKey, convKey, convConfig, toolLineageInfo, {
              sid: sessionId,
              rid: requestId,
              startTime: requestStartTime,
            })
          },
        })
        res.writeHead(200, SSE_HEADERS)
        const reader = readableStream.getReader() as ReadableStreamDefaultReader<Uint8Array>
        void pipeReaderToResponse(reader, res)
      } else {
        const response = await collectNonStreamingResponse(existingSession, modelId)
        // Update lineage after successful tool-result turn completion
        const stored = getConversationState(convKey)
        if (stored && response.ok) {
          const completedTurns = [...turns, { userText }]
          stored.lineageTurnCount = completedTurns.length
          stored.lineageFingerprint = computeLineageFingerprint(completedTurns)
          persistConversation(convKey, stored, convConfig)
        }
        removeActiveSession(sessionKey)
        logRequestEnd(sessionId, requestId, { durationMs: Date.now() - requestStartTime })
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        res.end(await response.text())
      }
      return
    }
    // Session is gone — fall through to fresh request
    removeActiveSession(sessionKey)
  }

  // ── Fresh request ──
  logSessionCreate(sessionId, requestId, { sessionKey, conversationKey: convKey })
  const stored = resolveConversationState(convKey, convConfig)

  // ── Lineage validation ──
  // Compute incoming lineage from completed turns and validate against stored lineage.
  // On mismatch (fork, compaction, branch switch), discard the stale checkpoint.
  const incomingLineage: LineageMetadata = {
    turnCount: turns.length,
    fingerprint: computeLineageFingerprint(turns),
  }
  if (stored.checkpoint !== null && !validateLineage(stored, incomingLineage)) {
    stored.checkpoint = null
    stored.checkpointHistory.clear()
    stored.checkpointArchive.clear()
    stored.blobStore.clear()
  }

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
    cfg.nativeToolsMode,
  )

  const allowedRoot = cfg.nativeToolsMode === 'native' && piCwd ? resolveAllowedRoot(piCwd) : undefined
  const sessionOptions: SessionOptions = {
    accessToken,
    requestBytes: payload.requestBytes,
    blobStore: payload.blobStore,
    mcpTools,
    cloudRule: systemPrompt || undefined,
    nativeToolsMode: cfg.nativeToolsMode,
    allowedRoot,
    convKey,
    onCheckpoint: (checkpointBytes, blobStoreRef) => {
      stored.checkpoint = checkpointBytes
      // Sync blob store reference
      for (const [k, v] of blobStoreRef) {
        stored.blobStore.set(k, v)
      }
      persistConversation(convKey, stored, convConfig)
      logCheckpointCommit(sessionId, requestId, { sizeBytes: checkpointBytes.length })
    },
  }

  const session = new CursorSession(sessionOptions)

  // Cancel the Cursor session on client disconnect — sends CancelAction protobuf
  // and preserves the previous committed checkpoint (no pending checkpoint commit)
  req.on('close', () => {
    if (session.alive) {
      session.cancel()
    }
  })

  const lineageInfo: LineageInfo = { turns, userText: effectiveUserText }

  if (stream) {
    const completionId = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 28)}`
    const created = Math.floor(Date.now() / 1000)
    const readableStream = new ReadableStream({
      start(controller) {
        const ctx = createSSECtx(controller, modelId, completionId, created)
        void pumpAndFinalize(
          session,
          ctx,
          sessionKey,
          convKey,
          convConfig,
          lineageInfo,
          {
            sid: sessionId,
            rid: requestId,
            startTime: requestStartTime,
          },
          { sessionOptions, req, maxRetries: cfg.maxRetries },
        )
      },
    })
    res.writeHead(200, SSE_HEADERS)
    const reader = readableStream.getReader() as ReadableStreamDefaultReader<Uint8Array>
    void pipeReaderToResponse(reader, res)
  } else {
    // ── Non-streaming with retry ──
    let nonStreamAttempt = 0
    let currentNonStreamSession = session
    let response: Response
    for (;;) {
      response = await collectNonStreamingResponse(currentNonStreamSession, modelId)
      if (response.ok || nonStreamAttempt >= cfg.maxRetries) {
        break
      }
      nonStreamAttempt++
      console.error(`[proxy] Non-streaming retry ${nonStreamAttempt}/${cfg.maxRetries} (status ${response.status})`)
      await sleep(1000)
      currentNonStreamSession = new CursorSession(sessionOptions)
      req.on('close', () => {
        if (currentNonStreamSession.alive) {
          currentNonStreamSession.cancel()
        }
      })
    }
    // Update lineage after successful non-streaming turn completion
    if (response.ok) {
      const completedTurns = [...turns, { userText: effectiveUserText }]
      stored.lineageTurnCount = completedTurns.length
      stored.lineageFingerprint = computeLineageFingerprint(completedTurns)
    }
    persistConversation(convKey, stored, convConfig)
    logRequestEnd(sessionId, requestId, { durationMs: Date.now() - requestStartTime })
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  }
}

/**
 * Lineage context for updating lineage after successful turn completion.
 */
interface LineageInfo {
  turns: { userText: string }[]
  userText: string
}

/**
 * Context for creating new sessions on retry. When omitted, retries are
 * disabled (e.g. tool-result resume where session options are unavailable).
 */
interface RetryContext {
  sessionOptions: SessionOptions
  req: IncomingMessage
  maxRetries: number
}

/**
 * Pump a session and handle batchReady (keep session alive for tool-result
 * continuation) or done (clean up).  When `retryCtx` is provided and
 * `pumpSession` returns a retryable failure, the failed session is closed
 * and a fresh session is created (up to `maxRetries` times).
 */
async function pumpAndFinalize(
  session: CursorSession,
  ctx: ReturnType<typeof createSSECtx>,
  sessionKey: string,
  convKey: string,
  convConfig: ConversationConfig,
  lineageInfo?: LineageInfo,
  debugInfo?: { sid: string; rid: string; startTime: number },
  retryCtx?: RetryContext,
): Promise<void> {
  let currentSession = session
  let attempt = 0

  try {
    for (;;) {
      const result: PumpResult = await pumpSession(currentSession, ctx)

      if (result.outcome === 'batchReady') {
        // Keep session alive for tool-result continuation
        setActiveSession(sessionKey, currentSession)
        return
      }

      // ── Retryable failure — create a new session and retry ──
      if (result.outcome === 'retry' && retryCtx && attempt < retryCtx.maxRetries) {
        removeActiveSession(sessionKey)
        currentSession.close()
        attempt++
        const delayMs = retryDelayMs(result.retryHint)
        console.error(
          `[proxy] Retry ${attempt}/${retryCtx.maxRetries} after ${result.retryHint}: ${result.error} (delay ${delayMs}ms)`,
        )
        await sleep(delayMs)

        // New session with the same options — checkpoint preserves conversation state
        currentSession = new CursorSession(retryCtx.sessionOptions)
        retryCtx.req.on('close', () => {
          if (currentSession.alive) {
            currentSession.cancel()
          }
        })
        continue
      }

      // ── Done or final retry failure — persist and clean up ──
      const stored = getConversationState(convKey)
      if (stored) {
        // Update lineage only after successful turn completion (outcome === 'done').
        // On retry/error, preserve previous committed lineage.
        if (result.outcome === 'done' && lineageInfo) {
          const completedTurns = [...lineageInfo.turns, { userText: lineageInfo.userText }]
          stored.lineageTurnCount = completedTurns.length
          stored.lineageFingerprint = computeLineageFingerprint(completedTurns)
        }
        persistConversation(convKey, stored, convConfig)
      }
      removeActiveSession(sessionKey)
      currentSession.close()

      // Surface the error when retries are exhausted
      if (result.outcome === 'retry') {
        ctx.sendChunk({ content: `\n[Error: ${result.error} (retries exhausted)]` })
        ctx.sendChunk({}, 'stop')
        ctx.sendDone()
      }

      if (debugInfo) {
        const error = result.outcome === 'retry' ? result.error : undefined
        logRequestEnd(debugInfo.sid, debugInfo.rid, {
          durationMs: Date.now() - debugInfo.startTime,
          error,
        })
      }
      return
    }
  } catch (error) {
    console.error('[proxy] pumpSession error:', error)
    removeActiveSession(sessionKey)
    currentSession.close()
    ctx.close()
    if (debugInfo) {
      logRequestEnd(debugInfo.sid, debugInfo.rid, {
        durationMs: Date.now() - debugInfo.startTime,
        error: error instanceof Error ? error.message : String(error),
      })
    }
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

  const portFilePath = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')

  function shutdown(): void {
    console.error('[proxy] Shutdown requested')
    closeAllSessions()
    try {
      unlinkSync(portFilePath)
    } catch {
      /* may not exist */
    }
    process.exit(0)
  }

  // 2. Discover models
  let models: CursorModel[] = []
  try {
    models = await discoverCursorModels(config.accessToken)
    console.error(`[proxy] Discovered ${String(models.length)} models`)
  } catch (error) {
    console.error('[proxy] Model discovery failed:', error)
  }

  // 3. Configure internal API (once, after model discovery)
  configureInternalApi({
    initialToken: config.accessToken,
    initialModels: models,
    onShutdown: shutdown,
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
    evictStaleConversations()
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
