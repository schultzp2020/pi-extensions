/**
 * Proxy lifecycle management.
 *
 * Manages the cursor-proxy child process from the extension side:
 * spawn, discover via port file, reconnect, heartbeat, shutdown.
 *
 * Multiple Pi sessions share one proxy via the port file at
 * ~/.pi/agent/cursor-proxy.json. Each session sends heartbeats;
 * the proxy self-exits after 30s without any heartbeat.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import type { CursorModel } from './proxy/models.ts'

// ── Constants ──

const PORT_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')
const PROXY_ENTRY = resolve(import.meta.dirname, 'proxy', 'main.ts')
const HEARTBEAT_INTERVAL_MS = 10_000
const PROXY_STARTUP_TIMEOUT_MS = 15_000
const HEALTH_CHECK_TIMEOUT_MS = 2_000
const HEARTBEAT_TIMEOUT_MS = 2_000
const TOKEN_PUSH_TIMEOUT_MS = 2_000
const MODEL_REFRESH_TIMEOUT_MS = 10_000

// ── Types ──

interface ProxyInfo {
  port: number
  pid: number
}

interface ProxyConnection {
  port: number
  pid: number
  heartbeatTimer: NodeJS.Timeout
  sessionId: string
}

// ── State ──

let activeConnection: ProxyConnection | null = null

// ── Process utilities ──

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence check only
    return true
  } catch {
    return false
  }
}

// ── Port file ──

/**
 * Read the port file. Returns proxy info if the file exists and the
 * process is still alive, otherwise cleans up the stale file.
 */
export function readPortFile(): ProxyInfo | null {
  try {
    if (!existsSync(PORT_FILE)) {
      return null
    }
    const data = JSON.parse(readFileSync(PORT_FILE, 'utf8')) as ProxyInfo
    if (data.port && data.pid && isProcessAlive(data.pid)) {
      return data
    }
    // Stale port file — clean up
    try {
      unlinkSync(PORT_FILE)
    } catch {
      // ignore cleanup errors
    }
    return null
  } catch {
    return null
  }
}

function writePortFile(info: ProxyInfo): void {
  mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true })
  writeFileSync(PORT_FILE, JSON.stringify(info))
}

// ── HTTP helpers ──

async function checkProxyHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${String(port)}/internal/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

async function sendHeartbeat(port: number, sessionId: string): Promise<void> {
  try {
    await fetch(`http://localhost:${String(port)}/internal/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    })
  } catch {
    // Heartbeat failures are non-fatal — proxy may be temporarily busy
  }
}

async function pushToken(port: number, accessToken: string): Promise<void> {
  try {
    await fetch(`http://localhost:${String(port)}/internal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: accessToken }),
      signal: AbortSignal.timeout(TOKEN_PUSH_TIMEOUT_MS),
    })
  } catch {
    // Token push failures are non-fatal — will retry on next request
  }
}

// ── Public API ──

/**
 * Refresh the model list from the proxy.
 */
async function refreshModels(port: number): Promise<CursorModel[]> {
  const res = await fetch(`http://localhost:${String(port)}/internal/refresh-models`, {
    method: 'POST',
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  })
  const data = (await res.json()) as { models: CursorModel[] }
  return data.models
}

/**
 * Connect to an existing proxy or spawn a new one.
 *
 * 1. Checks the port file for a running proxy and validates via health check.
 * 2. If no healthy proxy exists, spawns a new child process.
 * 3. Starts the heartbeat timer for the given session.
 */
export async function connectToProxy(
  sessionId: string,
  accessToken: string | null,
): Promise<{ port: number; models: CursorModel[] }> {
  // 1. Try existing proxy via port file
  const existing = readPortFile()
  if (existing && (await checkProxyHealth(existing.port))) {
    if (accessToken) {
      await pushToken(existing.port, accessToken)
    }
    startHeartbeat(existing.port, existing.pid, sessionId)
    const models = await refreshModels(existing.port)
    return { port: existing.port, models }
  }

  // 2. No existing proxy — need to spawn
  if (!accessToken) {
    throw new Error('No access token and no existing proxy')
  }
  return spawnProxy(sessionId, accessToken)
}

// ── Spawn ──

async function spawnProxy(sessionId: string, accessToken: string): Promise<{ port: number; models: CursorModel[] }> {
  const child = spawn('node', ['--experimental-transform-types', PROXY_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })

  // Send config on stdin
  // stdio: ['pipe','pipe','pipe'] guarantees these are non-null
  const { stdin, stdout, stderr, pid: childPid } = child
  stdin.write(`${JSON.stringify({ accessToken })}\n`)
  stdin.end()

  // Read ready signal from stdout
  const rl = createInterface({ input: stdout })
  const readyLine = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Proxy startup timeout'))
    }, PROXY_STARTUP_TIMEOUT_MS)
    rl.once('line', (line) => {
      clearTimeout(timeout)
      resolve(line)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Proxy exited with code ${String(code)}`))
    })
  })
  rl.close()

  const ready = JSON.parse(readyLine) as { type: string; port: number; models?: CursorModel[] }
  if (ready.type !== 'ready' || !ready.port || !childPid) {
    throw new Error(`Unexpected proxy output: ${readyLine}`)
  }

  // Write port file for other sessions to discover
  writePortFile({ port: ready.port, pid: childPid })

  // Start heartbeat
  startHeartbeat(ready.port, childPid, sessionId)

  // Log proxy stderr to file
  const logPath = join(homedir(), '.pi', 'agent', 'cursor-proxy.log')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  stderr.on('data', (chunk: Buffer) => {
    logStream.write(`${new Date().toISOString()} ${chunk.toString()}`)
  })

  // Don't let the child keep the parent alive
  child.unref()

  return { port: ready.port, models: ready.models ?? [] }
}

// ── Heartbeat ──

function startHeartbeat(port: number, pid: number, sessionId: string): void {
  stopHeartbeat()
  void sendHeartbeat(port, sessionId) // immediate first heartbeat
  const timer = setInterval(() => {
    void sendHeartbeat(port, sessionId)
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  activeConnection = { port, pid, heartbeatTimer: timer, sessionId }
}

/**
 * Stop the heartbeat timer and clear the active connection.
 */
export function stopHeartbeat(): void {
  if (activeConnection) {
    clearInterval(activeConnection.heartbeatTimer)
    activeConnection = null
  }
}

/**
 * Get the port of the currently active proxy, or null.
 */
export function getActivePort(): number | null {
  return activeConnection?.port ?? null
}
