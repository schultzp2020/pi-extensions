import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedModelSet } from './model-normalization.ts'
import type { ProxyContext } from './request-lifecycle.ts'
import type { ConversationConfig, StoredConversation } from './session-state.ts'

// ── Mocks ──

// Mock cursor-session — avoid real gRPC connections
vi.mock('./cursor-session.ts', () => {
  class MockCursorSession {
    alive = true
    close = vi.fn<() => void>()
    cancel = vi.fn<() => void>()
    sendToolResults = vi.fn<() => void>()
  }
  return { CursorSession: MockCursorSession }
})

// Mock session-state
vi.mock('./session-state.ts', async (importOriginal) => {
  // eslint-disable-next-line typescript-eslint/no-unnecessary-type-assertion -- needed for spread
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    resolveSession: vi.fn<() => unknown>(),
    registerBridge: vi.fn<() => void>(),
    commitTurn: vi.fn<() => void>(),
    closeBridge: vi.fn<() => void>(),
    getConversationState: vi.fn<() => unknown>(),
    persistConversation: vi.fn<() => void>(),
    resetConversation: vi.fn<() => void>(),
    pruneBlobs: vi.fn<() => number>(),
  }
})

// Mock openai-stream
vi.mock('./openai-stream.ts', () => ({
  collectNonStreamingResponse: vi.fn<() => unknown>(),
  createSSECtx: vi.fn<() => unknown>(),
  pumpSession: vi.fn<() => unknown>(),
  SSE_HEADERS: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
}))

// Mock debug-logger (no-ops)
vi.mock('./debug-logger.ts', () => ({
  debugRequestId: vi.fn<() => string>(() => 'test-req-id'),
  logCheckpointCommit: vi.fn<() => void>(),
  logLineageInvalidation: vi.fn<() => void>(),
  logRequestEnd: vi.fn<() => void>(),
  logRequestStart: vi.fn<() => void>(),
  logRetry: vi.fn<() => void>(),
  logSessionCreate: vi.fn<() => void>(),
  logSessionResume: vi.fn<() => void>(),
}))

// Mock http-helpers
vi.mock('./http-helpers.ts', () => ({
  readBody: vi.fn<() => unknown>(),
  jsonResponse: vi.fn<() => void>(),
  errorResponse: vi.fn<() => void>(),
}))

// Mock model-normalization
vi.mock('./model-normalization.ts', () => ({
  resolveModelId: vi.fn<(id: string) => string>((id: string) => id),
  processModels: vi.fn<() => unknown>(),
}))

// Mock request-context
vi.mock('./request-context.ts', () => ({
  buildRequestContext: vi.fn<() => Record<string, unknown>>(() => ({})),
}))

// Mock native-tools
vi.mock('./native-tools.ts', () => ({
  MCP_TOOL_PREFIX: 'mcp_',
  resolveAllowedRoot: vi.fn<(cwd: string) => string>((cwd: string) => cwd),
}))

import { readBody, errorResponse } from './http-helpers.ts'
import { collectNonStreamingResponse, pumpSession, createSSECtx } from './openai-stream.ts'
import { handleChatCompletion } from './request-lifecycle.ts'
import { commitTurn, persistConversation, resetConversation, resolveSession } from './session-state.ts'

// ── Helpers ──

const TEST_CONV_CONFIG: ConversationConfig = { conversationDiskDir: '/tmp/test-conv' }

function makeProxyContext(overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    getAccessToken: () => 'test-token',
    getNormalizedSet: () => ({ models: [], byId: new Map(), effortMap: new Map() }) as unknown as NormalizedModelSet,
    convConfig: TEST_CONV_CONFIG,
    config: {
      nativeToolsMode: 'reject',
      maxMode: false,
      fast: false,
      thinking: true,
      maxRetries: 2,
    },
    ...overrides,
  }
}

function makeStoredConversation(overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    conversationId: 'conv-123',
    checkpoint: null,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    checkpointHistory: new Map(),
    checkpointArchive: new Map(),
    lineageTurnCount: 0,
    lineageFingerprint: null,
    ...overrides,
  }
}

function makeRequest(): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'POST'
  req.url = '/v1/chat/completions'
  return req
}

function makeResponse(): ServerResponse {
  const socket = new Socket()
  const res = new ServerResponse(new IncomingMessage(socket))
  vi.spyOn(res, 'writeHead').mockReturnValue(res)
  vi.spyOn(res, 'write').mockReturnValue(true)
  vi.spyOn(res, 'end').mockReturnValue(res)
  return res
}

const VALID_BODY = JSON.stringify({
  model: 'claude-3.5-sonnet',
  messages: [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hello' },
  ],
  stream: false,
})

// ── Tests ──

describe('handleChatCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('retry behavior', () => {
    it('retries on transient failure (non-streaming) and succeeds on second attempt', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      // First call: fail with 503
      // Second call: succeed with 200
      const failResponse = new Response('error', { status: 503 })
      const okResponse = new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      vi.mocked(collectNonStreamingResponse)
        .mockResolvedValueOnce({ response: failResponse, retryHint: 'timeout' })
        .mockResolvedValueOnce({ response: okResponse })

      await handleChatCompletion(req, res, ctx)

      // collectNonStreamingResponse called twice (original + 1 retry)
      expect(collectNonStreamingResponse).toHaveBeenCalledTimes(2)
      // commitTurn called on success
      expect(commitTurn).toHaveBeenCalledTimes(1)
    })

    it('gives up after maxRetries exhausted (non-streaming)', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext({
        config: {
          nativeToolsMode: 'reject',
          maxMode: false,
          fast: false,
          thinking: true,
          maxRetries: 1,
        },
      })

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      const failResponse = new Response('error', { status: 503 })
      vi.mocked(collectNonStreamingResponse).mockResolvedValue({ response: failResponse, retryHint: 'timeout' })

      await handleChatCompletion(req, res, ctx)

      // 1 original + 1 retry = 2 calls total
      expect(collectNonStreamingResponse).toHaveBeenCalledTimes(2)
      // commitTurn NOT called (all attempts failed)
      expect(commitTurn).not.toHaveBeenCalled()
      // persistConversation called to save state
      expect(persistConversation).toHaveBeenCalled()
    })

    it('resets conversation on blob_not_found (non-streaming)', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation({ checkpoint: new Uint8Array([1, 2, 3]) })
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      const failResponse = new Response('blob not found', { status: 500 })
      const okResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      vi.mocked(collectNonStreamingResponse)
        .mockResolvedValueOnce({ response: failResponse, retryHint: 'blob_not_found' })
        .mockResolvedValueOnce({ response: okResponse })

      await handleChatCompletion(req, res, ctx)

      // resetConversation should have been called for blob_not_found
      expect(resetConversation).toHaveBeenCalledWith(stored)
    })
  })

  describe('lineage invalidation', () => {
    it('reports lineage invalidation when stored lineage does not match', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation({ lineageTurnCount: 5 })
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: true, // session-state detected mismatch
      })

      const okResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      vi.mocked(collectNonStreamingResponse).mockResolvedValue({ response: okResponse })

      const { logLineageInvalidation } = await import('./debug-logger.ts')
      await handleChatCompletion(req, res, ctx)

      // Lineage invalidation should have been logged
      expect(logLineageInvalidation).toHaveBeenCalled()
    })
  })

  describe('checkpoint commit', () => {
    it('calls commitTurn after successful non-streaming turn', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      const okResponse = new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      vi.mocked(collectNonStreamingResponse).mockResolvedValue({ response: okResponse })

      await handleChatCompletion(req, res, ctx)

      expect(commitTurn).toHaveBeenCalledTimes(1)
      // Verify lineage metadata passed
      expect(commitTurn).toHaveBeenCalledWith(
        'default',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ turnCount: 1, fingerprint: expect.any(String) }),
        TEST_CONV_CONFIG,
      )
    })

    it('does not call commitTurn on failed non-streaming response', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext({
        config: {
          nativeToolsMode: 'reject',
          maxMode: false,
          fast: false,
          thinking: true,
          maxRetries: 0,
        },
      })

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      const failResponse = new Response('error', { status: 500 })
      vi.mocked(collectNonStreamingResponse).mockResolvedValue({ response: failResponse })

      await handleChatCompletion(req, res, ctx)

      expect(commitTurn).not.toHaveBeenCalled()
      // But state should be persisted
      expect(persistConversation).toHaveBeenCalled()
    })
  })

  describe('streaming vs non-streaming', () => {
    it('uses SSE headers for streaming requests', async () => {
      const streamBody = JSON.stringify({
        model: 'claude-3.5-sonnet',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      })
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(streamBody)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      // Mock SSE context
      const mockCtx = {
        sendChunk: vi.fn<() => void>(),
        sendDone: vi.fn<() => void>(),
        close: vi.fn<() => void>(),
      }
      vi.mocked(createSSECtx).mockReturnValue(mockCtx as unknown as ReturnType<typeof createSSECtx>)

      // pumpSession resolves immediately with done
      vi.mocked(pumpSession).mockResolvedValue({ outcome: 'done' })

      await handleChatCompletion(req, res, ctx)

      // Should use SSE headers — verify writeHead was called with SSE content type
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
        }),
      )
    })

    it('uses collectNonStreamingResponse for non-streaming requests', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext()

      vi.mocked(readBody).mockResolvedValue(VALID_BODY)

      const stored = makeStoredConversation()
      vi.mocked(resolveSession).mockReturnValue({
        bridge: undefined,
        conversation: stored,
        lineageInvalidated: false,
      })

      const okResponse = new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      vi.mocked(collectNonStreamingResponse).mockResolvedValue({ response: okResponse })

      await handleChatCompletion(req, res, ctx)

      // For non-streaming, uses collectNonStreamingResponse
      expect(collectNonStreamingResponse).toHaveBeenCalledTimes(1)
      // pumpSession should NOT be called for non-streaming
      expect(pumpSession).not.toHaveBeenCalled()
    })
  })

  describe('auth', () => {
    it('returns 401 when no access token', async () => {
      const req = makeRequest()
      const res = makeResponse()
      const ctx = makeProxyContext({ getAccessToken: () => null })

      await handleChatCompletion(req, res, ctx)

      expect(errorResponse).toHaveBeenCalledWith(res, 401, 'No access token configured')
    })
  })
})
