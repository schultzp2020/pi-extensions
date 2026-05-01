import { describe, it, expect } from 'vitest'

import {
  frameConnectMessage,
  createConnectFrameParser,
  parseConnectEndStream,
  decodeConnectUnaryBody,
  CONNECT_END_STREAM_FLAG,
} from './connect-protocol.ts'

describe('frameConnectMessage', () => {
  it('creates a 5-byte header + payload', () => {
    const data = new TextEncoder().encode('hello')
    const frame = frameConnectMessage(data)
    expect(frame[0]).toBe(0) // flags = 0
    expect(frame.readUInt32BE(1)).toBe(5) // length
    expect(frame.subarray(5)).toEqual(Buffer.from(data))
  })

  it('sets flags when provided', () => {
    const data = new Uint8Array([1, 2, 3])
    const frame = frameConnectMessage(data, CONNECT_END_STREAM_FLAG)
    expect(frame[0]).toBe(CONNECT_END_STREAM_FLAG)
  })
})

describe('createConnectFrameParser', () => {
  it('parses a single complete frame', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const data = new TextEncoder().encode('test')
    const frame = frameConnectMessage(data)
    parser(Buffer.from(frame))
    expect(messages).toHaveLength(1)
    expect(Buffer.from(messages[0])).toEqual(Buffer.from(data))
  })

  it('handles partial frames across multiple chunks', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const data = new TextEncoder().encode('hello world')
    const frame = frameConnectMessage(data)
    const mid = Math.floor(frame.length / 2)
    parser(Buffer.from(frame.subarray(0, mid)))
    expect(messages).toHaveLength(0) // not yet complete
    parser(Buffer.from(frame.subarray(mid)))
    expect(messages).toHaveLength(1)
  })

  it('routes end-stream frames to onEndStream', () => {
    const endStreams: Uint8Array[] = []
    const parser = createConnectFrameParser(
      () => {},
      (bytes) => endStreams.push(bytes),
    )
    const data = new TextEncoder().encode('{"error":{"code":"internal"}}')
    const frame = frameConnectMessage(data, CONNECT_END_STREAM_FLAG)
    parser(Buffer.from(frame))
    expect(endStreams).toHaveLength(1)
  })

  it('parses multiple frames in one chunk', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const frame1 = frameConnectMessage(new TextEncoder().encode('one'))
    const frame2 = frameConnectMessage(new TextEncoder().encode('two'))
    parser(Buffer.concat([Buffer.from(frame1), Buffer.from(frame2)]))
    expect(messages).toHaveLength(2)
  })
})

describe('parseConnectEndStream', () => {
  it('returns Error for error payloads', () => {
    const data = new TextEncoder().encode(JSON.stringify({ error: { code: 'internal', message: 'Blob not found' } }))
    const err = parseConnectEndStream(data)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('internal')
    expect((err as Error).message).toContain('Blob not found')
  })

  it('returns null for clean end stream', () => {
    const data = new TextEncoder().encode(JSON.stringify({}))
    expect(parseConnectEndStream(data)).toBeNull()
  })
})

describe('decodeConnectUnaryBody', () => {
  it('extracts payload from a single data frame', () => {
    const payload = new TextEncoder().encode('protobuf-bytes')
    const frame = frameConnectMessage(payload)
    const result = decodeConnectUnaryBody(new Uint8Array(frame))
    expect(result).not.toBeNull()
    expect(Buffer.from(result as Uint8Array)).toEqual(Buffer.from(payload))
  })

  it('returns null for too-short input', () => {
    expect(decodeConnectUnaryBody(new Uint8Array([1, 2]))).toBeNull()
  })
})
