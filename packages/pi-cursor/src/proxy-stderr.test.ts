import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { captureProxyStderr } from './proxy-stderr.ts'

describe('captureProxyStderr', () => {
  it('drains stderr without writing to the parent terminal', () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)

    stream.write('[proxy] Listening on port 1234\n')
    capture.finishStartup()
    stream.write('[proxy] Shutdown requested\n')

    expect(stream.readableFlowing).toBeTruthy()
  })

  it('includes startup diagnostics in startup errors', () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)

    stream.write('[proxy] accessToken is required\n')

    expect(capture.startupError(new Error('Proxy exited with code 1')).message).toBe(
      'Proxy exited with code 1\nProxy stderr:\n[proxy] accessToken is required',
    )
  })

  it('keeps only the configured number of startup bytes', () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream, 5)

    stream.write('123456789')

    expect(capture.startupError(new Error('failed')).message).toBe('failed\nProxy stderr:\n56789')
  })
})
