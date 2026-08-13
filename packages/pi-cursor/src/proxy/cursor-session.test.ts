import { create, toBinary } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
} from '../proto/agent_pb.ts'
import { CONNECT_END_STREAM_FLAG, frameConnectMessage } from './connect-protocol.ts'

interface MockStream {
  emit: (event: string, ...args: unknown[]) => void
}

const h2Mock = vi.hoisted(() => ({
  streams: [] as MockStream[],
}))

vi.mock('node:http2', () => {
  type Listener = (...args: unknown[]) => void

  class MockEmitter {
    private readonly listeners = new Map<string, Listener[]>()

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
    }
  }

  class MockHttp2Stream extends MockEmitter {
    write = vi.fn<() => void>()
    close = vi.fn<() => void>()
  }

  class MockHttp2Session extends MockEmitter {
    readonly stream = new MockHttp2Stream()
    close = vi.fn<() => void>()

    request(): MockHttp2Stream {
      h2Mock.streams.push(this.stream)
      return this.stream
    }
  }

  return {
    connect: vi.fn<() => MockHttp2Session>(() => new MockHttp2Session()),
  }
})

import { CursorSession, type SessionOptions } from './cursor-session.ts'

function makeSessionOptions(): SessionOptions {
  return {
    accessToken: 'test-token',
    requestBytes: new Uint8Array([1]),
    blobStore: new Map(),
    mcpTools: [],
    nativeToolsMode: 'reject',
    convKey: 'test-conversation',
  }
}

function missingBlobFrame(): Buffer {
  const kvMessage = create(KvServerMessageSchema, {
    id: 1,
    message: {
      case: 'getBlobArgs',
      value: create(GetBlobArgsSchema, { blobId: new Uint8Array([1, 2, 3]) }),
    },
  })
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: 'kvServerMessage', value: kvMessage },
  })
  return frameConnectMessage(toBinary(AgentServerMessageSchema, serverMessage))
}

function genericErrorFrame(): Buffer {
  const payload = new TextEncoder().encode(JSON.stringify({ error: { code: 'internal', message: 'Error' } }))
  return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG)
}

function pendingToolCallFrame(): Buffer {
  const execMessage = create(ExecServerMessageSchema, {
    id: 1,
    execId: 'exec-1',
    message: {
      case: 'mcpArgs',
      value: create(McpArgsSchema, {
        toolName: 'mcp_pi_test',
        toolCallId: 'tool-1',
        args: {},
      }),
    },
  })
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: 'execServerMessage', value: execMessage },
  })
  return frameConnectMessage(toBinary(AgentServerMessageSchema, serverMessage))
}

function latestStream(): MockStream {
  const stream = h2Mock.streams.at(-1)
  if (!stream) {
    throw new Error('Expected CursorSession to open an HTTP/2 stream')
  }
  return stream
}

describe('CursorSession blob miss recovery', () => {
  beforeEach(() => {
    h2Mock.streams.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps a generic terminal error to blob_not_found after this Bridge observes a GetBlob miss', async () => {
    const session = new CursorSession(makeSessionOptions())
    const stream = latestStream()

    stream.emit('data', missingBlobFrame())
    stream.emit('data', genericErrorFrame())

    await expect(session.next()).resolves.toEqual({
      type: 'done',
      error: 'Connect error internal: Error',
      retryHint: 'blob_not_found',
    })
  })

  it('does not add a blob_not_found hint to a bridge connection loss after a GetBlob miss', async () => {
    const session = new CursorSession(makeSessionOptions())
    const stream = latestStream()

    stream.emit('data', missingBlobFrame())
    stream.emit('error', new Error('socket reset'))

    await expect(session.next()).resolves.toEqual({
      type: 'done',
      error: 'bridge connection lost',
    })
  })

  it('does not add a blob_not_found hint when a session with pending tool calls closes after a GetBlob miss', async () => {
    const options = makeSessionOptions()
    options.mcpTools = [create(McpToolDefinitionSchema, { toolName: 'mcp_pi_test' })]
    const session = new CursorSession(options)
    const stream = latestStream()

    stream.emit('data', missingBlobFrame())
    stream.emit('data', pendingToolCallFrame())
    stream.emit('error', new Error('socket reset'))

    await expect(session.next()).resolves.toMatchObject({ type: 'toolCall' })
    await expect(session.next()).resolves.toEqual({
      type: 'done',
      error: 'session closed with pending tool calls',
    })
  })

  it('does not classify an unrelated generic error as blob_not_found in another Bridge', async () => {
    const sessionWithMiss = new CursorSession(makeSessionOptions())
    latestStream().emit('data', missingBlobFrame())
    sessionWithMiss.close()

    const unrelatedSession = new CursorSession(makeSessionOptions())
    latestStream().emit('data', genericErrorFrame())

    await expect(unrelatedSession.next()).resolves.toEqual({
      type: 'done',
      error: 'Connect error internal: Error',
      retryHint: undefined,
    })
  })
})
