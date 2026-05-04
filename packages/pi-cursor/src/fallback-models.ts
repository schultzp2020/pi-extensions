import type { CursorModel } from './proxy/models.ts'

/**
 * Static fallback model list for pre-login / cold-start availability.
 * Used when no model cache exists and model discovery hasn't run yet.
 *
 * Only includes the latest generation of each model family.
 * Once the proxy connects, this is replaced by live discovery data.
 *
 * Last synced with ~/.pi/agent/cursor-model-cache.json on 2026-05-04.
 */
export const FALLBACK_MODELS: CursorModel[] = [
  // ── Claude (latest per tier) ──
  {
    id: 'claude-4.6-sonnet',
    name: 'Sonnet 4.6',
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'claude-4.6-opus',
    name: 'Opus 4.6',
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'claude-4.5-haiku',
    name: 'Haiku 4.5',
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },

  // ── GPT (latest per tier) ──
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    reasoning: true,
    contextWindow: 922_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'Codex 5.3',
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },

  // ── Gemini (latest per tier) ──
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },

  // ── Grok ──
  {
    id: 'grok-4-20',
    name: 'Grok 4.20',
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
  },

  // ── Composer (latest) ──
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
