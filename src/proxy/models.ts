/**
 * Cursor model discovery.
 *
 * Two strategies:
 * 1. AvailableModels RPC (aiserver.v1) — rich data: capabilities, context limits, display names.
 * 2. GetUsableModels RPC (agent.v1)   — fallback: basic model IDs + thinking details.
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'

import {
  GetUsableModelsRequestSchema,
  type GetUsableModelsResponse,
  GetUsableModelsResponseSchema,
  type ModelDetails,
} from '../proto/agent_pb.ts'
import {
  AvailableModelsRequestSchema,
  type AvailableModelsResponse,
  type AvailableModelsResponse_AvailableModel,
  AvailableModelsResponseSchema,
} from '../proto/aiserver_pb.ts'
import { decodeConnectUnaryBody } from './connect-protocol.ts'
import { callCursorUnaryRpc } from './cursor-session.ts'

// ── Constants ──

const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels'
const GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels'

const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000

/** Hardcoded context-window fallbacks for known models. */
const MODEL_LIMITS: Partial<Record<string, { context?: number; maxTokens?: number }>> = {
  'claude-4-sonnet': { context: 1_000_000 },
  'claude-4-sonnet-1m': { context: 1_000_000 },
  'claude-4.5-haiku': { context: 200_000 },
  'claude-4.5-opus': { context: 1_000_000 },
  'claude-4.5-sonnet': { context: 1_000_000 },
  'claude-4.6-opus': { context: 1_000_000 },
  'claude-4.6-sonnet': { context: 1_000_000 },
  'composer-1.5': { context: 1_000_000 },
  'composer-2': { context: 200_000 },
  'gemini-2.5-flash': { context: 1_000_000 },
  'gemini-3-flash': { context: 1_000_000 },
  'gemini-3.1-pro': { context: 1_000_000 },
  'gpt-5.1': { context: 272_000 },
  'gpt-5.1-codex-max': { context: 272_000 },
  'gpt-5.1-codex-mini': { context: 272_000 },
  'gpt-5.2': { context: 272_000 },
  'gpt-5.2-codex': { context: 272_000 },
  'gpt-5.3-codex': { context: 272_000 },
  'gpt-5.4': { context: 922_000 },
  'gpt-5.4-mini': { context: 272_000 },
  'gpt-5.4-nano': { context: 272_000 },
}

// ── Types ──

export interface CursorModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
}

// ── Pretty model names ──

const PRETTY_NAME_OVERRIDES: Record<string, string> = {
  'composer-1': 'Composer 1',
  'composer-1.5': 'Composer 1.5',
  'composer-2': 'Composer 2',
}

const RAW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function prettyCursorModelName(modelId: string): string {
  const normalizedId = modelId.trim().toLowerCase()
  if (!normalizedId) {
    return modelId
  }
  const overridden = PRETTY_NAME_OVERRIDES[normalizedId]
  if (overridden) {
    return overridden
  }

  const parts = normalizedId.split('-').filter(Boolean)
  if (parts.length === 0) {
    return modelId
  }

  switch (parts[0]) {
    case 'claude': {
      return formatClaudeName(parts.slice(1))
    }
    case 'gpt': {
      return formatGptName(parts.slice(1))
    }
    case 'gemini': {
      return formatPrefixedName('Gemini', parts.slice(1))
    }
    case 'composer': {
      return formatPrefixedName('Composer', parts.slice(1))
    }
    default: {
      return parts.map(formatToken).join(' ')
    }
  }
}

function resolveCursorModelName(modelId: string, discoveredName?: string): string {
  const preferredName = discoveredName?.trim()
  if (preferredName && !looksLikeRawModelName(preferredName, modelId)) {
    return preferredName
  }
  return prettyCursorModelName(modelId)
}

function looksLikeRawModelName(name: string, modelId: string): boolean {
  const normalizedName = name.trim()
  if (!normalizedName) {
    return true
  }
  if (normalizedName.toLowerCase() === modelId.trim().toLowerCase()) {
    return true
  }
  return RAW_NAME_PATTERN.test(normalizedName)
}

function formatClaudeName(parts: string[]): string {
  const [version, family, ...rest] = parts
  return ['Claude', family ? formatToken(family) : '', version || '', ...rest.map(formatToken)]
    .filter(Boolean)
    .join(' ')
}

function formatGptName(parts: string[]): string {
  const [version, ...rest] = parts
  return [`GPT${version ? `-${version}` : ''}`, ...rest.map(formatToken)].filter(Boolean).join(' ')
}

function formatPrefixedName(prefix: string, parts: string[]): string {
  return [prefix, ...parts.map(formatToken)].join(' ')
}

function formatToken(token: string): string {
  if (/^\d+(\.\d+)?$/.test(token)) {
    return token
  }
  if (/^\d+m$/.test(token)) {
    return `${token.slice(0, -1)}M`
  }
  if (token === 'xhigh') {
    return 'XHigh'
  }
  if (token === 'gpt') {
    return 'GPT'
  }
  return token.charAt(0).toUpperCase() + token.slice(1)
}

// ── Fallback context window lookup ──

function fallbackContext(modelId: string): number {
  const exact = MODEL_LIMITS[modelId]
  if (exact?.context) {
    return exact.context
  }

  // Strip mode suffixes and try base model
  const base = modelId.replaceAll(/-(max-thinking|thinking|max|high|medium|low|fast|xhigh|none)$/g, '')
  if (base !== modelId) {
    const baseLimits = MODEL_LIMITS[base]
    if (baseLimits?.context) {
      return baseLimits.context
    }
  }

  return DEFAULT_CONTEXT_WINDOW
}

// ── Connect-protocol decode helper ──

function decodeConnectResponse<T>(schema: Parameters<typeof fromBinary>[0], payload: Uint8Array): T | null {
  try {
    return fromBinary(schema, payload) as T
  } catch {
    // May be Connect-framed — try extracting the data frame
    const framedBody = decodeConnectUnaryBody(payload)
    if (!framedBody) {
      return null
    }
    try {
      return fromBinary(schema, framedBody) as T
    } catch {
      return null
    }
  }
}

// ── Primary: AvailableModels RPC ──

function normalizeAvailableModel(m: AvailableModelsResponse_AvailableModel): CursorModel | null {
  const id = m.name.trim()
  if (!id) {
    return null
  }

  // Filter out models that are hidden, chat-only, or cmd-k only
  if (m.isHidden) {
    return null
  }
  if (m.isChatOnly) {
    return null
  }
  if (m.onlySupportsCmdK) {
    return null
  }

  const context = m.contextTokenLimit ?? fallbackContext(id)

  return {
    id,
    name: resolveCursorModelName(id, m.clientDisplayName),
    reasoning: m.supportsThinking === true,
    contextWindow: context,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages: m.supportsImages === true,
  }
}

async function fetchAvailableModels(accessToken: string): Promise<CursorModel[] | null> {
  try {
    const req = create(AvailableModelsRequestSchema, {
      includeLongContextModels: true,
      includeHiddenModels: true,
    })

    const responseBytes = await callCursorUnaryRpc({
      accessToken,
      rpcPath: AVAILABLE_MODELS_PATH,
      requestBody: toBinary(AvailableModelsRequestSchema, req),
    })

    if (responseBytes.length === 0) {
      return null
    }

    const decoded = decodeConnectResponse<AvailableModelsResponse>(AvailableModelsResponseSchema, responseBytes)
    if (!decoded || decoded.models.length === 0) {
      return null
    }

    const models = decoded.models.map((m) => normalizeAvailableModel(m)).filter((m): m is CursorModel => m !== null)

    return models.length > 0 ? models.sort((a, b) => a.id.localeCompare(b.id)) : null
  } catch {
    return null
  }
}

// ── Fallback: GetUsableModels RPC ──

function pickLegacyName(model: ModelDetails): string {
  for (const name of [model.displayName, model.displayNameShort, model.displayModelId]) {
    if (name.trim()) {
      return resolveCursorModelName(model.modelId, name)
    }
  }
  return prettyCursorModelName(model.modelId)
}

function normalizeLegacyModels(models: readonly ModelDetails[]): CursorModel[] {
  const byId = new Map<string, CursorModel>()
  for (const m of models) {
    const id = m.modelId.trim()
    if (!id) {
      continue
    }

    const ctx = fallbackContext(id)
    const exactLimits = MODEL_LIMITS[id]

    byId.set(id, {
      id,
      name: pickLegacyName(m),
      reasoning: m.thinkingDetails !== undefined,
      contextWindow: ctx,
      maxTokens: exactLimits?.maxTokens ?? DEFAULT_MAX_TOKENS,
      supportsImages: false, // GetUsableModels doesn't expose this
    })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function fetchUsableModels(accessToken: string): Promise<CursorModel[] | null> {
  try {
    const requestBody = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}))
    const responseBytes = await callCursorUnaryRpc({
      accessToken,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
    })

    if (responseBytes.length === 0) {
      return null
    }

    const decoded = decodeConnectResponse<GetUsableModelsResponse>(GetUsableModelsResponseSchema, responseBytes)
    if (!decoded) {
      return null
    }

    const models = normalizeLegacyModels(decoded.models)
    return models.length > 0 ? models : null
  } catch {
    return null
  }
}

// ── Public API ──

/**
 * Discover all usable Cursor models for the given access token.
 *
 * Tries AvailableModels RPC first (richer data: capabilities, context limits,
 * display names, image support). Falls back to GetUsableModels RPC (basic model
 * IDs + thinking details). Returns empty array if both fail.
 */
export async function discoverCursorModels(accessToken: string): Promise<CursorModel[]> {
  // Try primary path first — richer data
  const available = await fetchAvailableModels(accessToken)
  if (available && available.length > 0) {
    console.error(`[models] Discovered ${String(available.length)} models via AvailableModels`)
    return available
  }

  // Fallback — basic model IDs
  const usable = await fetchUsableModels(accessToken)
  if (usable && usable.length > 0) {
    console.error(`[models] Fell back to GetUsableModels: ${String(usable.length)} models`)
    return usable
  }

  console.error('[models] Both discovery methods failed, returning empty list')
  return []
}
