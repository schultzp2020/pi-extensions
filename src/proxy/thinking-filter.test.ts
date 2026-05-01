import { describe, it, expect } from 'vitest'

import { createThinkingTagFilter } from './thinking-filter.ts'

describe('createThinkingTagFilter', () => {
  it('passes plain text through as content', () => {
    const filter = createThinkingTagFilter()
    const result = filter.process('hello world')
    expect(result.content).toBe('hello world')
    expect(result.reasoning).toBe('')
  })

  it('routes <thinking> tagged content to reasoning', () => {
    const filter = createThinkingTagFilter()
    const r1 = filter.process('<thinking>let me think')
    expect(r1.content).toBe('')
    expect(r1.reasoning).toBe('let me think')
    const r2 = filter.process('</thinking>answer')
    expect(r2.content).toBe('answer')
    expect(r2.reasoning).toBe('')
  })

  it('handles all tag variants', () => {
    for (const tag of ['think', 'thinking', 'reasoning', 'thought', 'think_intent']) {
      const filter = createThinkingTagFilter()
      const r = filter.process(`<${tag}>inside</${tag}>outside`)
      expect(r.reasoning).toBe('inside')
      expect(r.content).toBe('outside')
    }
  })

  it('buffers partial tags across chunks', () => {
    const filter = createThinkingTagFilter()
    const r1 = filter.process('before<thi')
    expect(r1.content).toBe('before')
    expect(r1.reasoning).toBe('')
    const r2 = filter.process('nking>inside</thinking>after')
    expect(r2.reasoning).toBe('inside')
    expect(r2.content).toBe('after')
  })

  it('flush() emits buffered content', () => {
    const filter = createThinkingTagFilter()
    filter.process('text<thi')
    const flushed = filter.flush()
    expect(flushed.content).toBe('<thi')
  })
})
