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
  AgentRunRequestSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  McpToolDefinitionSchema,
  type McpToolDefinition,
  ModelDetailsSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from '../proto/agent_pb.ts'
import { resolveEffective, type NativeToolsMode } from './config.ts'
import { CursorSession, type RetryHint, type SessionOptions } from './cursor-session.ts'
import {
  debugRequestId,
  logCheckpointCommit,
  logLineageInvalidation,
  logRequestEnd,
  logRequestStart,
  logRetry,
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
  closeAll,
  closeBridge,
  commitTurn,
  computeLineageFingerprint,
  evict,
  getConversationState,
  persistConversation,
  pruneBlobs,
  registerBridge,
  resetConversation,
  resolveSession,
  type ConversationConfig,
  type StoredConversation,
} from './session-state.ts'

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

/** Base delay (ms) before retrying based on the failure hint, with jitter. */
function retryDelayMs(hint: RetryHint): number {
  let base: number
  switch (hint) {
    case 'blob_not_found': {
      base = 200
      break
    }
    case 'resource_exhausted': {
      base = 2000
      break
    }
    case 'timeout': {
      base = 1000
      break
    }
  }
  // Add 0-50% jitter to prevent thundering herd
  return Math.round(base * (1 + Math.random() * 0.5))
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

/**
 * Maximum byte size for the effective system prompt after folding turns.
 * Older turns are dropped (newest-first) when the combined size exceeds this.
 */
const MAX_EFFECTIVE_PROMPT_BYTES = 100_000

/**
 * Fold prior conversation turns into the system prompt so the LLM retains
 * context even when no checkpoint is available (e.g. after compaction).
 *
 * If the combined size exceeds MAX_EFFECTIVE_PROMPT_BYTES, the oldest turns
 * are dropped and a note is prepended indicating truncation.
 */
export function foldTurnsIntoSystemPrompt(
  systemPrompt: string,
  turns: { userText: string; assistantText: string; isCompaction?: boolean }[],
): string {
  if (turns.length === 0) {
    return systemPrompt
  }

  const contextParts = turns.map((t) => {
    if (t.isCompaction) {
      return `<context>\n${t.userText}\n</context>`
    }
    return `User: ${t.userText}${t.assistantText ? `\nAssistant: ${t.assistantText}` : ''}`
  })

  // Try full fold first
  const fullFold = `${systemPrompt}\n\nPrevious conversation context:\n${contextParts.join('\n\n')}`
  if (new TextEncoder().encode(fullFold).byteLength <= MAX_EFFECTIVE_PROMPT_BYTES) {
    return fullFold
  }

  // Truncate oldest turns until under the cap.
  // Compaction/context-summary turns are prioritized — they are reserved first
  // so that pre-compaction context survives truncation.  Real conversation turns
  // fill the remaining budget newest-first.
  console.error(
    `[proxy] Folded system prompt exceeds ${String(MAX_EFFECTIVE_PROMPT_BYTES)} bytes — truncating oldest turns`,
  )
  const prefix = `${systemPrompt}\n\nPrevious conversation context (oldest turns truncated):\n`
  let budget = MAX_EFFECTIVE_PROMPT_BYTES - new TextEncoder().encode(prefix).byteLength

  // Partition into compaction and regular indices
  const compactionIndices: number[] = []
  const regularIndices: number[] = []
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].isCompaction) {
      compactionIndices.push(i)
    } else {
      regularIndices.push(i)
    }
  }

  // Reserve budget for compaction turns first (in original order)
  const keptIndices = new Set<number>()
  for (const idx of compactionIndices) {
    const partBytes = new TextEncoder().encode(contextParts[idx]).byteLength + 2
    if (partBytes > budget) {
      break
    }
    budget -= partBytes
    keptIndices.add(idx)
  }

  // Fill remaining budget with regular turns, newest first
  for (let i = regularIndices.length - 1; i >= 0; i--) {
    const idx = regularIndices[i]
    const partBytes = new TextEncoder().encode(contextParts[idx]).byteLength + 2
    if (partBytes > budget) {
      break
    }
    budget -= partBytes
    keptIndices.add(idx)
  }

  if (keptIndices.size === 0) {
    return systemPrompt
  }

  // Reassemble in original order
  const kept = [...keptIndices].sort((a, b) => a - b).map((i) => contextParts[i])
  return `${prefix}${kept.join('\n\n')}`
}

function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: { userText: string; assistantText: string; isCompaction?: boolean }[],
  conversationId: string,
  checkpoint: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  nativeToolsMode: NativeToolsMode = 'reject',
): { requestBytes: Uint8Array; blobStore: Map<string, Uint8Array>; mcpTools: McpToolDefinition[] } {
  // Try decoding a persisted checkpoint
  const decodedCheckpoint = checkpoint ? decodeCheckpointState(checkpoint) : null

  let conversationState: ReturnType<typeof create<typeof ConversationStateStructureSchema>>
  let effectiveSystemPrompt = systemPrompt

  if (decodedCheckpoint) {
    conversationState = decodedCheckpoint
  } else {
    // No checkpoint — start a fresh conversation with empty turns.
    //
    // Cursor's server treats the `turns` field as blob references (not inline
    // data).  Putting serialized turn bytes there causes "Blob not found"
    // errors.  Instead, fold any prior turns into the system prompt so the
    // LLM still sees the conversation context.
    if (turns.length > 0) {
      effectiveSystemPrompt = foldTurnsIntoSystemPrompt(systemPrompt, turns)
    }
    conversationState = create(ConversationStateStructureSchema, { turns: [] })
  }

  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: randomUUID(),
  })
  const requestContext = buildRequestContext(mcpTools, effectiveSystemPrompt || undefined, nativeToolsMode)
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
    const { bridge: existingSession } = resolveSession(sessionId, convConfig)
    if (existingSession?.alive) {
      logSessionResume(sessionId, requestId, { sessionKey: sessionId })
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
            void pumpAndFinalize(existingSession, ctx, sessionId, convConfig, toolLineageInfo, {
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
        const { response } = await collectNonStreamingResponse(existingSession, modelId)
        // Update lineage after successful tool-result turn completion
        if (response.ok) {
          const completedTurns = [...turns, { userText }]
          commitTurn(
            sessionId,
            {
              turnCount: completedTurns.length,
              fingerprint: computeLineageFingerprint(completedTurns),
            },
            convConfig,
          )
        }
        closeBridge(sessionId)
        logRequestEnd(sessionId, requestId, { durationMs: Date.now() - requestStartTime })
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        res.end(await response.text())
      }
      return
    }
    // Session is gone — fall through to fresh request
    closeBridge(sessionId)
  }

  // ── Fresh request ──
  const { conversation: stored, lineageInvalidated } = resolveSession(sessionId, convConfig, turns)
  logSessionCreate(sessionId, requestId, { sessionKey: sessionId, conversationKey: sessionId })
  if (lineageInvalidated) {
    logLineageInvalidation(sessionId, requestId, {
      storedTurnCount: stored.lineageTurnCount,
      incomingTurnCount: turns.length,
      blobCount: stored.blobStore.size,
    })
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
    convKey: sessionId,
    onCheckpoint: (checkpointBytes) => {
      stored.checkpoint = checkpointBytes
      // blobStore is a shared Map reference — SetBlob mutations from
      // handleKvMessage are already visible in stored.blobStore.
      // Prune oldest blobs if the store exceeds the size cap.
      pruneBlobs(stored.blobStore)
      persistConversation(sessionId, stored, convConfig)
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
          sessionId,
          convConfig,
          lineageInfo,
          {
            sid: sessionId,
            rid: requestId,
            startTime: requestStartTime,
          },
          {
            sessionOptions,
            req,
            maxRetries: cfg.maxRetries,
            rebuildWithoutCheckpoint: (s) =>
              buildCursorRequest(
                modelId,
                systemPrompt,
                effectiveUserText,
                turns,
                s.conversationId,
                null,
                s.blobStore,
                mcpTools,
                cfg.nativeToolsMode,
              ).requestBytes,
          },
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
    let currentNonStreamOptions = sessionOptions
    let result = await collectNonStreamingResponse(currentNonStreamSession, modelId)
    let nonStreamCloseHandler: (() => void) | null = null
    while (!result.response.ok && nonStreamAttempt < cfg.maxRetries) {
      nonStreamAttempt++
      const hint: RetryHint = result.retryHint ?? (result.response.status === 429 ? 'resource_exhausted' : 'timeout')
      const delayMs = retryDelayMs(hint)
      logRetry(sessionId, requestId, { attempt: nonStreamAttempt, hint, delayMs })
      console.error(
        `[proxy] Non-streaming retry ${nonStreamAttempt}/${cfg.maxRetries} (status ${result.response.status})`,
      )
      await sleep(delayMs)

      // On blob_not_found: reset conversation and rebuild request (mirrors streaming path)
      if (hint === 'blob_not_found') {
        resetConversation(stored)
        currentNonStreamOptions = {
          ...currentNonStreamOptions,
          requestBytes: buildCursorRequest(
            modelId,
            systemPrompt,
            effectiveUserText,
            turns,
            stored.conversationId,
            null,
            stored.blobStore,
            mcpTools,
            cfg.nativeToolsMode,
          ).requestBytes,
        }
        persistConversation(sessionId, stored, convConfig)
        console.error('[proxy] blob_not_found: rebuilt non-streaming request with new conversation ID for retry')
      }

      currentNonStreamSession = new CursorSession(currentNonStreamOptions)
      // Remove previous close handler to prevent listener accumulation
      if (nonStreamCloseHandler) {
        req.removeListener('close', nonStreamCloseHandler)
      }
      const sessionToCancel = currentNonStreamSession
      nonStreamCloseHandler = () => {
        if (sessionToCancel.alive) {
          sessionToCancel.cancel()
        }
      }
      req.on('close', nonStreamCloseHandler)
      result = await collectNonStreamingResponse(currentNonStreamSession, modelId)
    }
    const { response } = result
    // Update lineage after successful non-streaming turn completion
    if (response.ok) {
      const completedTurns = [...turns, { userText: effectiveUserText }]
      commitTurn(
        sessionId,
        {
          turnCount: completedTurns.length,
          fingerprint: computeLineageFingerprint(completedTurns),
        },
        convConfig,
      )
    } else {
      persistConversation(sessionId, stored, convConfig)
    }
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
  /** Rebuild requestBytes without checkpoint for blob_not_found recovery. */
  rebuildWithoutCheckpoint?: (stored: StoredConversation) => Uint8Array
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
  sessionId: string,
  convConfig: ConversationConfig,
  lineageInfo?: LineageInfo,
  debugInfo?: { sid: string; rid: string; startTime: number },
  retryCtx?: RetryContext,
): Promise<void> {
  let currentSession = session
  let attempt = 0
  let streamCloseHandler: (() => void) | null = null

  try {
    for (;;) {
      const result: PumpResult = await pumpSession(currentSession, ctx)

      if (result.outcome === 'batchReady') {
        // Keep session alive for tool-result continuation
        registerBridge(sessionId, currentSession)
        return
      }

      // ── Retryable failure — create a new session and retry ──
      if (result.outcome === 'retry' && retryCtx && attempt < retryCtx.maxRetries) {
        closeBridge(sessionId)
        currentSession.close()
        attempt++
        const delayMs = retryDelayMs(result.retryHint)
        if (debugInfo) {
          logRetry(debugInfo.sid, debugInfo.rid, { attempt, hint: result.retryHint, delayMs })
        }
        console.error(
          `[proxy] Retry ${attempt}/${retryCtx.maxRetries} after ${result.retryHint}: ${result.error} (delay ${delayMs}ms)`,
        )
        await sleep(delayMs)

        // On blob_not_found: reset conversation (new ID, clear blobs) and
        // rebuild requestBytes so the retry starts a fresh Cursor conversation.
        // Called unconditionally (not guarded by stored?.checkpoint) because
        // the new conversation ID is needed regardless of checkpoint state.
        if (result.retryHint === 'blob_not_found') {
          const stored = getConversationState(sessionId)
          if (stored) {
            resetConversation(stored)
            if (retryCtx.rebuildWithoutCheckpoint) {
              retryCtx.sessionOptions = {
                ...retryCtx.sessionOptions,
                requestBytes: retryCtx.rebuildWithoutCheckpoint(stored),
              }
            }
            persistConversation(sessionId, stored, convConfig)
            console.error('[proxy] blob_not_found: rebuilt request with new conversation ID for retry')
          }
        }

        // New session — either same options (transient error) or
        // rebuilt options (blob_not_found checkpoint discard)
        currentSession = new CursorSession(retryCtx.sessionOptions)
        // Remove previous close handler to prevent listener accumulation
        if (streamCloseHandler) {
          retryCtx.req.removeListener('close', streamCloseHandler)
        }
        const sessionToCancel = currentSession
        streamCloseHandler = () => {
          if (sessionToCancel.alive) {
            sessionToCancel.cancel()
          }
        }
        retryCtx.req.on('close', streamCloseHandler)
        continue
      }

      // ── Done or final retry failure — persist and clean up ──
      // Update lineage only after successful turn completion (outcome === 'done').
      // On retry/error, preserve previous committed lineage.
      if (result.outcome === 'done' && lineageInfo) {
        const completedTurns = [...lineageInfo.turns, { userText: lineageInfo.userText }]
        commitTurn(
          sessionId,
          {
            turnCount: completedTurns.length,
            fingerprint: computeLineageFingerprint(completedTurns),
          },
          convConfig,
        )
      } else {
        const stored = getConversationState(sessionId)
        if (stored) {
          persistConversation(sessionId, stored, convConfig)
        }
      }
      closeBridge(sessionId)
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
    closeBridge(sessionId)
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
    closeAll()
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
    onModelsRefreshed: () => invalidateNormalizedModels(),
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
    evict()
  }, 60_000)
  if (typeof evictionTimer === 'object' && 'unref' in evictionTimer) {
    evictionTimer.unref()
  }

  server.listen(0, '127.0.0.1', () => {
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
