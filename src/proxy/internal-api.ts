/**
 * Internal API endpoints for proxy management.
 *
 * Handles heartbeat, token updates, health checks, and model refresh
 * from Pi extension sessions communicating with the shared proxy.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { discoverCursorModels, type CursorModel } from './models.ts'

interface SessionHeartbeat {
  sessionId: string
  lastHeartbeatMs: number
}

const activeSessions = new Map<string, SessionHeartbeat>()
const HEARTBEAT_TIMEOUT_MS = 30_000

let currentAccessToken: string | null = null
let cachedModels: CursorModel[] = []
let onModelsRefreshed: ((models: CursorModel[]) => void) | null = null
let shutdownCallback: (() => void) | null = null

export function configureInternalApi(opts: {
  initialToken: string | null
  initialModels: CursorModel[]
  onModelsRefreshed?: (models: CursorModel[]) => void
  onShutdown?: () => void
}): void {
  currentAccessToken = opts.initialToken
  cachedModels = opts.initialModels
  onModelsRefreshed = opts.onModelsRefreshed ?? null
  shutdownCallback = opts.onShutdown ?? null
}

export function getAccessToken(): string | null {
  return currentAccessToken
}

export function getCachedModels(): CursorModel[] {
  return cachedModels
}

export function startHeartbeatMonitor(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [id] of activeSessions) {
      const session = activeSessions.get(id)
      if (session && now - session.lastHeartbeatMs > HEARTBEAT_TIMEOUT_MS) {
        activeSessions.delete(id)
      }
    }
    if (activeSessions.size === 0) {
      console.error('[proxy] No active sessions, shutting down')
      shutdownCallback?.()
    }
  }, 10_000)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  return timer
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export async function handleInternalRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === '/internal/health' && req.method === 'GET') {
    jsonResponse(res, 200, {
      status: 'ok',
      sessions: activeSessions.size,
      hasToken: currentAccessToken !== null,
      modelCount: cachedModels.length,
    })
    return
  }

  if (path === '/internal/heartbeat' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { sessionId?: string }
    const { sessionId } = body
    if (!sessionId) {
      jsonResponse(res, 400, { error: 'sessionId required' })
      return
    }
    activeSessions.set(sessionId, { sessionId, lastHeartbeatMs: Date.now() })
    jsonResponse(res, 200, { ok: true })
    return
  }

  if (path === '/internal/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { access?: string }
    if (body.access) {
      currentAccessToken = body.access
      jsonResponse(res, 200, { ok: true })
    } else {
      jsonResponse(res, 400, { error: 'access token required' })
    }
    return
  }

  if (path === '/internal/refresh-models' && req.method === 'POST') {
    if (!currentAccessToken) {
      jsonResponse(res, 400, { error: 'no access token' })
      return
    }
    try {
      const models = await discoverCursorModels(currentAccessToken)
      cachedModels = models
      onModelsRefreshed?.(models)
      jsonResponse(res, 200, { models })
    } catch (error) {
      jsonResponse(res, 500, { error: String(error) })
    }
    return
  }

  jsonResponse(res, 404, { error: 'not found' })
}
