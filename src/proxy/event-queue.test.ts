import { describe, it, expect } from 'vitest'

import { EventQueue, MAX_QUEUE_DEPTH } from './event-queue.ts'

describe('EventQueue', () => {
  it('delivers buffered events via next()', async () => {
    const q = new EventQueue<string>()
    q.push('a')
    q.push('b')
    expect(await q.next()).toBe('a')
    expect(await q.next()).toBe('b')
  })

  it('waits for events when buffer is empty', async () => {
    const q = new EventQueue<string>()
    const promise = q.next()
    q.push('delayed')
    expect(await promise).toBe('delayed')
  })

  it('delivers directly to waiter without buffering', async () => {
    const q = new EventQueue<number>()
    const promise = q.next()
    q.push(42)
    expect(await promise).toBe(42)
    expect(q.length).toBe(0)
  })

  it('calls onOverflow when buffer exceeds MAX_QUEUE_DEPTH', () => {
    let overflowed = false
    const q = new EventQueue<number>({
      onOverflow: () => {
        overflowed = true
      },
    })
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      q.push(i)
    }
    expect(overflowed).toBeFalsy()
    const accepted = q.push(MAX_QUEUE_DEPTH)
    expect(accepted).toBeFalsy()
    expect(overflowed).toBeTruthy()
  })

  it('pushForce bypasses overflow limit', () => {
    const q = new EventQueue<number>()
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      q.push(i)
    }
    q.pushForce(-1)
    expect(q.length).toBe(MAX_QUEUE_DEPTH + 1)
  })
})
