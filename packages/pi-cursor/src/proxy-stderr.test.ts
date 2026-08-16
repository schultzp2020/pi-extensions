import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { captureProxyStderr } from './proxy-stderr.ts'

interface ListenerCounts {
  data: number
  end: number
  close: number
  error: number
}

function listenerCounts(stream: PassThrough): ListenerCounts {
  return {
    data: stream.listenerCount('data'),
    end: stream.listenerCount('end'),
    close: stream.listenerCount('close'),
    error: stream.listenerCount('error'),
  }
}

// The listener state dispose() leaves behind: output routing and the end
// tracker removed, the inert error sink and its close cleanup retained
// until the stream's own close removes them.
function withFinalSink(baseline: ListenerCounts): ListenerCounts {
  return { data: baseline.data, end: baseline.end, close: baseline.close + 1, error: baseline.error + 1 }
}

function destroyAndAwaitClose(stream: PassThrough): Promise<void> {
  stream.destroy()
  return new Promise<void>((resolve) => {
    stream.once('close', resolve)
  })
}

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
    const capture = captureProxyStderr(stream, { startupLimitBytes: 5 })

    stream.write('123456789')

    expect(capture.startupError(new Error('failed')).message).toBe('failed\nProxy stderr:\n56789')
  })

  it('routes output emitted after startup to the configured sink', () => {
    const stream = new PassThrough()
    const output: string[] = []
    const capture = captureProxyStderr(stream, { onOutput: (chunk) => output.push(chunk) })

    capture.finishStartup()
    stream.write('[proxy] Shutdown requested\n')

    expect(output).toEqual(['[proxy] Shutdown requested\n'])
  })

  it('waits for stderr that arrives after the drain starts', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)

    const drained = capture.drain(1_000)
    stream.write('[proxy] accessToken is required\n')
    stream.end()
    await drained

    expect(capture.startupError(new Error('Proxy exited with code 1')).message).toBe(
      'Proxy exited with code 1\nProxy stderr:\n[proxy] accessToken is required',
    )
  })

  it('bounds the drain wait when stderr never ends', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)

    stream.write('[proxy] partial output\n')
    await capture.drain(10)

    expect(capture.startupError(new Error('Proxy startup timeout')).message).toBe(
      'Proxy startup timeout\nProxy stderr:\n[proxy] partial output',
    )
  })
})

describe('captureProxyStderr drain cleanup', () => {
  // The baseline counts include the intentional persistent listeners the
  // capture installs for its lifetime (error handler plus terminal-state
  // trackers). A drain must add its three transient listeners and remove
  // exactly those on every settlement path.
  it('removes the transient drain listeners once the stream ends', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)

    const drained = capture.drain(1_000)
    expect(listenerCounts(stream)).toEqual({
      data: baseline.data,
      end: baseline.end + 1,
      close: baseline.close + 1,
      error: baseline.error + 1,
    })

    stream.end()
    await drained
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('removes the transient drain listeners once the stream closes without ending', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)

    const drained = capture.drain(1_000)
    stream.destroy()
    await drained
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('removes the transient drain listeners once the stream errors', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)

    const drained = capture.drain(1_000)
    stream.destroy(new Error('stderr transport failed'))
    await drained
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('removes the transient drain listeners when the deadline expires', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)

    await capture.drain(10)
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('settles a drain immediately when the stream already ended', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)
    stream.end()
    await new Promise<void>((resolve) => {
      stream.once('end', resolve)
    })

    // Must resolve through the tracked terminal state, not the deadline.
    const winner = await Promise.race([
      capture.drain(60_000).then(() => 'drain'),
      new Promise<'deadline'>((resolve) => {
        setTimeout(() => {
          resolve('deadline')
        }, 50).unref()
      }),
    ])

    expect(winner).toBe('drain')
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('handles a stream error queued before the drain starts and settles safely', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    const baseline = listenerCounts(stream)

    // destroy(error) marks the stream destroyed synchronously but emits
    // 'error' on a later tick. Without the persistent error handler this
    // queued event would crash the parent process.
    stream.destroy(new Error('stderr transport failed'))
    const drained = capture.drain(1_000)
    await drained
    expect(listenerCounts(stream)).toEqual(baseline)

    // The recorded error state makes every later drain settle immediately.
    await capture.drain(60_000)
    expect(listenerCounts(stream)).toEqual(baseline)
  })

  it('keeps an error after the stream ended handled', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    stream.end()
    await new Promise<void>((resolve) => {
      stream.once('end', resolve)
    })

    // The persistent error handler stays attached for the capture lifetime,
    // so a late transport failure remains handled instead of crashing.
    expect(stream.listenerCount('error')).toBeGreaterThan(0)
    stream.destroy(new Error('late stderr failure'))
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await capture.drain(1_000)
  })
})

describe('captureProxyStderr dispose', () => {
  it('removes output routing immediately and the final error sink only after close', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)
    // The capture owns exactly four persistent listeners: data routing plus
    // the three terminal-state trackers.
    expect(listenerCounts(stream)).toEqual({
      data: before.data + 1,
      end: before.end + 1,
      close: before.close + 1,
      error: before.error + 1,
    })

    capture.dispose()
    // Routing and the end tracker leave immediately. The inert error sink
    // and its close cleanup stay: destroy(error) can queue an 'error'
    // emission that a later no-arg destroy does not cancel, and only close
    // proves it was delivered.
    expect(listenerCounts(stream)).toEqual(withFinalSink(before))

    await destroyAndAwaitClose(stream)
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('is idempotent', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)
    capture.dispose()
    capture.dispose()

    // The second dispose adds nothing and removes nothing: exactly one
    // final error sink stays until close.
    expect(listenerCounts(stream)).toEqual(withFinalSink(before))
    await destroyAndAwaitClose(stream)
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('stops routing output and clears the startup buffer', () => {
    const stream = new PassThrough()
    const output: string[] = []
    const capture = captureProxyStderr(stream, { onOutput: (chunk) => output.push(chunk) })

    stream.write('before dispose\n')
    capture.dispose()
    stream.write('after dispose\n')

    expect(output).toEqual(['before dispose\n'])
    expect(capture.startupError(new Error('Proxy startup timeout')).message).toBe('Proxy startup timeout')
  })

  it('keeps the snapshot taken before disposal', () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    stream.write('[proxy] accessToken is required\n')

    // Diagnostics must survive in the error even after the capture state is
    // disposed: callers snapshot through startupError() first.
    const error = capture.startupError(new Error('Proxy startup timeout'))
    capture.dispose()

    expect(error.message).toBe('Proxy startup timeout\nProxy stderr:\n[proxy] accessToken is required')
  })

  it('settles later drains immediately', async () => {
    const stream = new PassThrough()
    const capture = captureProxyStderr(stream)
    capture.dispose()
    const afterDispose = listenerCounts(stream)

    const winner = await Promise.race([
      capture.drain(60_000).then(() => 'drain'),
      new Promise<'deadline'>((resolve) => {
        setTimeout(() => {
          resolve('deadline')
        }, 50).unref()
      }),
    ])

    expect(winner).toBe('drain')
    // The immediate drain attaches nothing; the retained final sink is the
    // only listener the capture still owns.
    expect(listenerCounts(stream)).toEqual(afterDispose)
  })
})

describe('captureProxyStderr dispose with active drains', () => {
  // dispose() must settle every drain still in flight: each settlement
  // clears its timer, removes its exact transient listeners, unregisters
  // itself, and resolves exactly once, so a disposed capture leaves
  // nothing attached to the stream and no live timer.
  it('settles an active drain immediately and removes its transient listeners', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)

    const drained = capture.drain(60_000)
    // The drain adds one transient end/close/error listener on top of the
    // capture's four persistent listeners.
    expect(listenerCounts(stream)).toEqual({
      data: before.data + 1,
      end: before.end + 2,
      close: before.close + 2,
      error: before.error + 2,
    })

    capture.dispose()
    const winner = await Promise.race([
      drained.then(() => 'drain'),
      new Promise<'deadline'>((resolve) => {
        setTimeout(() => {
          resolve('deadline')
        }, 50).unref()
      }),
    ])

    expect(winner).toBe('drain')
    // Disposal removed the routing and the transient drain listeners; the
    // retained final sink is the only capture listener left, and close
    // removes it.
    expect(listenerCounts(stream)).toEqual(withFinalSink(before))
    await destroyAndAwaitClose(stream)
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('settles every active drain and removes exactly their transient listeners', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)

    const first = capture.drain(60_000)
    const second = capture.drain(60_000)
    expect(listenerCounts(stream)).toEqual({
      data: before.data + 1,
      end: before.end + 3,
      close: before.close + 3,
      error: before.error + 3,
    })

    capture.dispose()
    await Promise.all([first, second])
    // Both transient listener sets are gone; the final sink remains until
    // the stream closes.
    expect(listenerCounts(stream)).toEqual(withFinalSink(before))
    await destroyAndAwaitClose(stream)
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('stays a no-op when disposed twice while drains are active', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)

    const drained = capture.drain(60_000)
    capture.dispose()
    capture.dispose()
    await drained

    // The second dispose neither re-settles the drain nor removes the
    // retained final sink early.
    expect(listenerCounts(stream)).toEqual(withFinalSink(before))
    await destroyAndAwaitClose(stream)
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('cancels the timers of active drains at disposal', async () => {
    vi.useFakeTimers()
    try {
      const stream = new PassThrough()
      const capture = captureProxyStderr(stream)
      expect(vi.getTimerCount()).toBe(0)

      void capture.drain(60_000)
      void capture.drain(60_000)
      expect(vi.getTimerCount()).toBe(2)

      capture.dispose()
      expect(vi.getTimerCount()).toBe(0)

      // Nothing fires later: the canceled deadlines cannot resurrect a
      // listener or a settlement after disposal.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(vi.getTimerCount()).toBe(0)
      expect(listenerCounts(stream).end).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('captureProxyStderr final error sink across destruction', () => {
  // destroy(error) marks the stream destroyed synchronously and queues the
  // 'error' emission for a later tick; a no-arg destroy cannot cancel it.
  // Production cleanup disposes inside that window, so the retained inert
  // sink is the only thing that keeps the queued error handled.
  it('keeps a queued destroy(error) handled across dispose and a later no-arg destroy', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)

    const closedPromise = new Promise<void>((resolve) => {
      stream.once('close', resolve)
    })
    stream.destroy(new Error('stderr transport failed'))
    capture.dispose()
    stream.destroy()

    // The queued 'error' emission runs while this await yields; an
    // unhandled one would crash the test process, so reaching the next
    // line is itself the regression assertion.
    await closedPromise
    expect(listenerCounts(stream)).toEqual(before)
  })

  it('keeps a queued destroy(error) handled when a drain was active at disposal', async () => {
    vi.useFakeTimers()
    try {
      const stream = new PassThrough()
      const before = listenerCounts(stream)
      const capture = captureProxyStderr(stream)

      void capture.drain(60_000)
      expect(vi.getTimerCount()).toBe(1)
      stream.destroy(new Error('stderr transport failed'))
      capture.dispose()
      // The active drain settled synchronously: its timer is gone and it
      // left nothing transient behind.
      expect(vi.getTimerCount()).toBe(0)
      expect(listenerCounts(stream)).toEqual(withFinalSink(before))

      // The queued 'error' and 'close' emissions run during the advance;
      // close removes the final sink. No timer or listener remains.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(vi.getTimerCount()).toBe(0)
      expect(listenerCounts(stream)).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the final sink at disposal when close already fired', async () => {
    const stream = new PassThrough()
    const before = listenerCounts(stream)
    const capture = captureProxyStderr(stream)

    await destroyAndAwaitClose(stream)
    // Close already proved no queued destruction error remains, so dispose
    // removes every capture listener immediately.
    capture.dispose()
    expect(listenerCounts(stream)).toEqual(before)
  })
})
