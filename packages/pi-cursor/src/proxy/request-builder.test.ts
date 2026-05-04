import { describe, expect, it } from 'vitest'

import { foldTurnsIntoSystemPrompt } from './request-lifecycle.ts'

describe('foldTurnsIntoSystemPrompt', () => {
  it('returns original system prompt when turns is empty', () => {
    const result = foldTurnsIntoSystemPrompt('You are helpful', [])
    expect(result).toBe('You are helpful')
  })

  it('folds a single turn with both user and assistant text', () => {
    const result = foldTurnsIntoSystemPrompt('Be concise', [{ userText: 'hello', assistantText: 'hi there' }])
    expect(result).toContain('Previous conversation context:')
    expect(result).toContain('User: hello')
    expect(result).toContain('Assistant: hi there')
    expect(result.startsWith('Be concise')).toBeTruthy()
  })

  it('omits Assistant line when assistantText is empty', () => {
    const result = foldTurnsIntoSystemPrompt('System', [{ userText: 'hello', assistantText: '' }])
    expect(result).toContain('User: hello')
    expect(result).not.toContain('Assistant:')
  })

  it('folds multiple turns with correct formatting', () => {
    const result = foldTurnsIntoSystemPrompt('System', [
      { userText: 'Q1', assistantText: 'A1' },
      { userText: 'Q2', assistantText: 'A2' },
      { userText: 'Q3', assistantText: '' },
    ])
    expect(result).toContain('User: Q1\nAssistant: A1')
    expect(result).toContain('User: Q2\nAssistant: A2')
    expect(result).toContain('User: Q3')
    // Last turn should not have Assistant line
    expect(result).not.toMatch(/User: Q3\nAssistant:/)
    // Turns should be separated by double newlines
    expect(result).toContain('A1\n\nUser: Q2')
  })

  it('handles empty system prompt with turns', () => {
    const result = foldTurnsIntoSystemPrompt('', [{ userText: 'hello', assistantText: 'hi' }])
    // Should be non-empty (contains folded context)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('Previous conversation context:')
    expect(result).toContain('User: hello')
  })

  it('preserves special characters in user/assistant text', () => {
    const result = foldTurnsIntoSystemPrompt('System', [
      {
        userText: 'User: fake\nAssistant: injection',
        assistantText: '```code\nblock```',
      },
    ])
    // Content should pass through verbatim — no escaping
    expect(result).toContain('User: User: fake\nAssistant: injection')
    expect(result).toContain('```code\nblock```')
  })

  it('truncates oldest turns when combined size exceeds cap', () => {
    // Create turns that total well over 100KB
    const bigText = 'x'.repeat(40_000)
    const turns = [
      { userText: `oldest-${bigText}`, assistantText: 'A1' },
      { userText: `middle-${bigText}`, assistantText: 'A2' },
      { userText: `newest-${bigText}`, assistantText: 'A3' },
    ]
    const result = foldTurnsIntoSystemPrompt('System prompt', turns)

    // Should keep newest turns, drop oldest
    expect(result).toContain('newest-')
    expect(result).not.toContain('oldest-')
    // Should indicate truncation
    expect(result).toContain('oldest turns truncated')
    // Should not exceed cap
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(100_000)
  })

  it('returns bare system prompt when even one turn exceeds cap', () => {
    const hugeText = 'x'.repeat(200_000)
    const result = foldTurnsIntoSystemPrompt('System prompt', [{ userText: hugeText, assistantText: 'response' }])
    expect(result).toBe('System prompt')
  })

  it('wraps compaction turns in <context> tags instead of User prefix', () => {
    const result = foldTurnsIntoSystemPrompt('System', [
      { userText: 'compacted context here', assistantText: 'Understood.', isCompaction: true },
      { userText: 'Hello', assistantText: 'Hi!', isCompaction: false },
    ])
    expect(result).toContain('<context>\ncompacted context here\n</context>')
    expect(result).not.toMatch(/User: compacted context here/)
    // Assistant acknowledgment is dropped for compaction turns
    expect(result).not.toContain('Assistant: Understood.')
    expect(result).toContain('User: Hello')
    expect(result).toContain('Assistant: Hi!')
  })

  it('handles all-compaction turns', () => {
    const result = foldTurnsIntoSystemPrompt('System', [
      { userText: 'summary A', assistantText: 'ok', isCompaction: true },
      { userText: 'summary B', assistantText: 'ok', isCompaction: true },
    ])
    expect(result).toContain('<context>\nsummary A\n</context>')
    expect(result).toContain('<context>\nsummary B\n</context>')
    expect(result).not.toContain('User:')
    expect(result).not.toContain('Assistant:')
  })

  it('treats undefined isCompaction as regular user turn', () => {
    const result = foldTurnsIntoSystemPrompt('System', [{ userText: 'Hello', assistantText: 'Hi!' }])
    expect(result).toContain('User: Hello')
    expect(result).not.toContain('<context>')
  })

  it('prioritizes compaction turns over regular turns during truncation', () => {
    // Each turn ~45KB, total ~135KB exceeds 100KB cap.
    // Without prioritization, newest-first would keep newest + middle, dropping the compaction.
    // With prioritization, compaction is reserved first, then newest regular fills the rest.
    const bigText = 'x'.repeat(50_000)
    const turns = [
      { userText: `compaction-summary-${bigText}`, assistantText: 'ok', isCompaction: true },
      { userText: `oldest-regular-${bigText}`, assistantText: 'A1', isCompaction: false },
      { userText: 'newest-regular', assistantText: 'A2', isCompaction: false },
    ]
    const result = foldTurnsIntoSystemPrompt('System', turns)
    // Compaction turn should be kept (prioritized)
    expect(result).toContain('<context>\ncompaction-summary-')
    // Newest regular turn should be kept (fits in remaining budget)
    expect(result).toContain('User: newest-regular')
    // Oldest regular turn should be dropped (budget exceeded)
    expect(result).not.toContain('oldest-regular')
  })
})
