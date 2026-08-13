import type { CursorModel } from './models.ts'

/** Startup payload sent from the proxy process to the extension process. */
export interface ProxyReadySignal {
  type: 'ready'
  port: number
  models: CursorModel[]
}

export function buildProxyReadySignal(port: number, models: CursorModel[]): ProxyReadySignal {
  return { type: 'ready', port, models }
}
