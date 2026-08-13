import { afterEach, describe, expect, it, vi } from 'vitest'

import { pushToken } from './proxy-lifecycle.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pushToken', () => {
  it('does not fetch when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await pushToken(3456, 'token', controller.signal)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('combines the caller signal with the push timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await pushToken(3456, 'token', controller.signal)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBeFalsy()
  })
})
