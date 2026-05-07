// src/proxy/openai-messages.test.ts
import { describe, it, expect } from 'vitest'

import {
  COMPACTION_MARKERS,
  extractImageParts,
  isCompactionText,
  parseMessages,
  selectToolsForChoice,
  textContent,
} from './openai-messages.ts'
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

describe('extractImageParts', () => {
  it('returns empty array for string content', () => {
    expect(extractImageParts('hello')).toEqual([])
  })

  it('returns empty array for null content', () => {
    expect(extractImageParts(null)).toEqual([])
  })

  it('extracts image URLs from content array', () => {
    const parts = [
      { type: 'text', text: 'Check this image' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
    ]
    const result = extractImageParts(parts)
    expect(result).toEqual([{ url: 'https://example.com/img.png' }])
  })

  it('extracts multiple images', () => {
    const parts = [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'https://example.com/b.png', detail: 'high' } },
    ]
    const result = extractImageParts(parts)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ url: 'https://example.com/a.png' })
    expect(result[1]).toEqual({ url: 'https://example.com/b.png', detail: 'high' })
  })

  it('preserves detail field when present', () => {
    const parts = [{ type: 'image_url', image_url: { url: 'https://example.com/img.png', detail: 'low' } }]
    const result = extractImageParts(parts)
    expect(result).toEqual([{ url: 'https://example.com/img.png', detail: 'low' }])
  })

  it('handles mixed text and image content', () => {
    const parts = [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      { type: 'text', text: 'after' },
    ]
    const result = extractImageParts(parts)
    expect(result).toEqual([{ url: 'data:image/png;base64,abc' }])
  })

  it('returns empty array for content with no images', () => {
    const parts = [{ type: 'text', text: 'just text' }]
    expect(extractImageParts(parts)).toEqual([])
  })

  it('returns empty array for empty content array', () => {
    expect(extractImageParts([])).toEqual([])
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
    expect(result.toolResults[0].toolCallId).toBe('tc1')
    expect(result.toolResults[0].name).toBe('read')
    expect(result.toolResults[0].content).toBe('file contents')
  })

  it('builds conversation turns from user/assistant pairs', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].userText).toBe('First question')
    expect(result.turns[0].assistantText).toBe('First answer')
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
    expect(result.turns[0].userText).toBe('Q1')
    expect(result.turns[0].assistantText).toBe('A1')
    expect(result.turns[1].userText).toBe('Q2')
    expect(result.turns[1].assistantText).toBe('A2')
    expect(result.userText).toBe('Q3')
  })

  it('handles single user message with no turns', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Just one message' }]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(0)
    expect(result.userText).toBe('Just one message')
  })

  it('preserves image parts from user messages', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } },
        ],
      },
    ]
    const result = parseMessages(messages)
    expect(result.userText).toBe('What is in this image?')
    expect(result.images).toEqual([{ url: 'https://example.com/screenshot.png' }])
  })

  it('handles messages with only images (no text parts)', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/diagram.png', detail: 'high' } }],
      },
    ]
    const result = parseMessages(messages)
    expect(result.userText).toBe('')
    expect(result.images).toEqual([{ url: 'https://example.com/diagram.png', detail: 'high' }])
  })

  it('handles messages with text and images mixed across turns', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First question' },
          { type: 'image_url', image_url: { url: 'https://example.com/img1.png' } },
        ],
      },
      { role: 'assistant', content: 'I see the image.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Second question' },
          { type: 'image_url', image_url: { url: 'https://example.com/img2.png' } },
        ],
      },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].images).toEqual([{ url: 'https://example.com/img1.png' }])
    expect(result.userText).toBe('Second question')
    expect(result.images).toEqual([{ url: 'https://example.com/img2.png' }])
  })

  it('returns empty images for string content user messages', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Just text' }]
    const result = parseMessages(messages)
    expect(result.images).toEqual([])
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
    expect(result[0].function.name).toBe('read')
  })

  it('returns empty when specific function not found', () => {
    const result = selectToolsForChoice(tools, { type: 'function', function: { name: 'nonexistent' } })
    expect(result).toHaveLength(0)
  })
})

describe('COMPACTION_MARKERS sync check', () => {
  // These are the full prefixes from @earendil-works/pi-coding-agent dist/core/messages.js.
  // If pi-core changes them, update COMPACTION_MARKERS and these expected values.
  const PI_CORE_COMPACTION_PREFIX =
    'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
  const PI_CORE_BRANCH_PREFIX =
    'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'

  it('compaction marker matches the start of pi-core COMPACTION_SUMMARY_PREFIX', () => {
    expect(PI_CORE_COMPACTION_PREFIX.startsWith(COMPACTION_MARKERS[0])).toBeTruthy()
  })

  it('branch marker matches the start of pi-core BRANCH_SUMMARY_PREFIX', () => {
    expect(PI_CORE_BRANCH_PREFIX.startsWith(COMPACTION_MARKERS[1])).toBeTruthy()
  })
})

describe('isCompactionText', () => {
  it('detects compaction summary prefix', () => {
    const text =
      'The conversation history before this point was compacted into the following summary:\n\n<summary>\nThe user discussed rules.\n</summary>'
    expect(isCompactionText(text)).toBeTruthy()
  })

  it('detects branch summary prefix', () => {
    const text =
      'The following is a summary of a branch that this conversation came back from:\n\n<summary>\nBranch context.\n</summary>'
    expect(isCompactionText(text)).toBeTruthy()
  })

  it('returns false for regular user text', () => {
    expect(isCompactionText('Hello, how are you?')).toBeFalsy()
  })

  it('returns false for empty string', () => {
    expect(isCompactionText('')).toBeFalsy()
  })

  it('returns false for text that mentions compaction but does not start with the prefix', () => {
    expect(isCompactionText('I see the conversation history was compacted')).toBeFalsy()
  })
})

describe('parseMessages — compaction detection', () => {
  const compactionText =
    'The conversation history before this point was compacted into the following summary:\n\n<summary>\nThe user asked about rules.\n</summary>'

  it('tags compaction turns with isCompaction: true', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: compactionText },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Hello' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].isCompaction).toBeTruthy()
    expect(result.turns[0].userText).toBe(compactionText)
    expect(result.userText).toBe('Hello')
  })

  it('tags regular turns with isCompaction: false', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].isCompaction).toBeFalsy()
  })

  it('handles mixed compaction and regular turns', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: compactionText },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'What now?' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0].isCompaction).toBeTruthy()
    expect(result.turns[1].isCompaction).toBeFalsy()
    expect(result.userText).toBe('What now?')
  })

  it('detects compaction in ContentPart[] format (pi-core real format)', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: compactionText }],
      },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Hello' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].isCompaction).toBeTruthy()
  })

  it('detects branch summary turns', () => {
    const branchText =
      'The following is a summary of a branch that this conversation came back from:\n\n<summary>\nBranch context.\n</summary>'
    const messages: OpenAIMessage[] = [
      { role: 'user', content: branchText },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'Continue' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].isCompaction).toBeTruthy()
  })
})
