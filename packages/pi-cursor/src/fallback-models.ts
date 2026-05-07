import type { CursorModel } from './proxy/models.ts'

/**
 * Static fallback model list for pre-login / cold-start availability.
 * Once the proxy connects, this is replaced by live discovery data.
 *
 * Last synced with Cursor AvailableModels API on 2026-05-07.
 */
export const FALLBACK_MODELS: CursorModel[] = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Opus 4.6',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'Codex 5.3',
    reasoning: true,
    contextWindow: 200_000,
    contextWindowMaxMode: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'composer-2',
    name: 'Composer 2',
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
]
