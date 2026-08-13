import { afterEach, describe, expect, it, vi } from 'vitest'

import { delay, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'

function b64url(json: object): string {
  return Buffer.from(JSON.stringify(json)).toString('base64url')
}

function fakeJwt(expSeconds: number): string {
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expSeconds })}.sig`
}

function abortError(message = 'This operation was aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('delay', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(delay(1000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when aborted during the wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = delay(5000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function runTimeoutImmediately(): void {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
    if (typeof handler === 'function') {
      ;(handler as () => void)()
    }
    return 0
  }) as typeof setTimeout)
}

describe('pollCursorAuth', () => {
  it('returns tokens when the poll succeeds', async () => {
    runTimeoutImmediately()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ accessToken: 'access', refreshToken: 'refresh' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(pollCursorAuth('uuid', 'verifier')).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rethrows AbortError instead of counting it as a soft poll failure', async () => {
    runTimeoutImmediately()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.reject(abortError()))
    vi.stubGlobal('fetch', fetchMock)

    await expect(pollCursorAuth('uuid', 'verifier')).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('stops polling when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(pollCursorAuth('uuid', 'verifier', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('refreshCursorToken', () => {
  it('passes the abort signal to fetch and returns rotated credentials', async () => {
    const controller = new AbortController()
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ accessToken: access, refreshToken: 'new-refresh' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshCursorToken('old-refresh', controller.signal)
    expect(result).toMatchObject({ access, refresh: 'new-refresh' })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })
  })

  it('propagates abort when the exchange is cancelled', async () => {
    const controller = new AbortController()
    const error = abortError()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) {
              reject(new Error('missing signal'))
              return
            }
            if (signal.aborted) {
              reject(error)
              return
            }
            signal.addEventListener('abort', () => reject(error), { once: true })
          }),
      ),
    )

    const pending = refreshCursorToken('old-refresh', controller.signal)
    controller.abort()
    await expect(pending).rejects.toBe(error)
  })
})

describe('getTokenExpiry', () => {
  it('subtracts a five-minute safety margin from the JWT exp claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    expect(getTokenExpiry(fakeJwt(exp))).toBe(exp * 1000 - 5 * 60 * 1000)
  })
})
