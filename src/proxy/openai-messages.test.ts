// src/proxy/openai-messages.test.ts
import { describe, it, expect } from 'vitest'

import { parseMessages, selectToolsForChoice, textContent } from './openai-messages.ts'
import type { OpenAIMessage, OpenAIToolDef } from './openai-messages.ts'

describe('textContent', () => {
  it('handles string content', () => {
    expect(textContent('hello')).toBe('hello')
  })

  it('handles null content', () => {
    expect(textContent(null)).toBe('')
  })

  it('handles undefined content', () => {
    expect(textContent(undefined)).toBe('')
  })

  it('handles content parts array', () => {
    const parts = [{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }]
    expect(textContent(parts)).toBe('hello\nworld')
  })

  it('handles empty array', () => {
    expect(textContent([])).toBe('')
  })
})

describe('parseMessages', () => {
  it('extracts system prompt', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    const result = parseMessages(messages)
    expect(result.systemPrompt).toBe('You are helpful.')
    expect(result.userText).toBe('Hi')
  })

  it('uses first system message only', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'First system.' },
      { role: 'system', content: 'Second system.' },
      { role: 'user', content: 'Hi' },
    ]
    const result = parseMessages(messages)
    expect(result.systemPrompt).toBe('First system.')
  })

  it('defaults systemPrompt to empty string when none present', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Hi' }]
    const result = parseMessages(messages)
    expect(result.systemPrompt).toBe('')
  })

  it('extracts tool results', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Do something' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{"path":"f.ts"}' } }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc1' },
    ]
    const result = parseMessages(messages)
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]!.toolCallId).toBe('tc1')
    expect(result.toolResults[0]!.name).toBe('read')
    expect(result.toolResults[0]!.content).toBe('file contents')
  })

  it('builds conversation turns from user/assistant pairs', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.userText).toBe('First question')
    expect(result.turns[0]!.assistantText).toBe('First answer')
    expect(result.userText).toBe('Second question')
  })

  it('handles multiple turns', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'Q3' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0]!.userText).toBe('Q1')
    expect(result.turns[0]!.assistantText).toBe('A1')
    expect(result.turns[1]!.userText).toBe('Q2')
    expect(result.turns[1]!.assistantText).toBe('A2')
    expect(result.userText).toBe('Q3')
  })

  it('handles single user message with no turns', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Just one message' }]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(0)
    expect(result.userText).toBe('Just one message')
  })
})

describe('selectToolsForChoice', () => {
  const tools: OpenAIToolDef[] = [
    { type: 'function', function: { name: 'read', description: 'Read a file' } },
    { type: 'function', function: { name: 'write', description: 'Write a file' } },
  ]

  it('returns all tools for auto', () => {
    expect(selectToolsForChoice(tools, 'auto')).toHaveLength(2)
  })

  it('returns all tools for required', () => {
    expect(selectToolsForChoice(tools, 'required')).toHaveLength(2)
  })

  it('returns all tools for undefined', () => {
    expect(selectToolsForChoice(tools, undefined)).toHaveLength(2)
  })

  it('returns empty for none', () => {
    expect(selectToolsForChoice(tools, 'none')).toHaveLength(0)
  })

  it('filters to specific function', () => {
    const result = selectToolsForChoice(tools, { type: 'function', function: { name: 'read' } })
    expect(result).toHaveLength(1)
    expect(result[0]!.function.name).toBe('read')
  })

  it('returns empty when specific function not found', () => {
    const result = selectToolsForChoice(tools, { type: 'function', function: { name: 'nonexistent' } })
    expect(result).toHaveLength(0)
  })
})
