/** Prefix Cursor uses for MCP tool names (e.g. `mcp_pi_read`). */
export const MCP_TOOL_PREFIX = 'mcp_pi_'

/** Removes the `mcp_pi_` prefix from a tool name, if present. */
export function stripMcpToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
}

/** Fixes argument name mismatches — Cursor sometimes sends `filePath` instead of `path`. */
export function fixMcpArgNames(toolName: string, args: Record<string, unknown>): void {
  // Cursor sometimes sends 'filePath' instead of 'path' for tools that expect 'path'
  if (['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(toolName) && args.filePath && !args.path) {
    args.path = args.filePath
    delete args.filePath
  }
}

export type ExecClassification = 'redirect' | 'passthrough' | 'internal' | 'reject'

/** Classifies a Cursor exec message type for routing: redirect to Pi, pass through, handle internally, or reject. */
export function classifyExecMessage(execCase: string): ExecClassification {
  const redirectable = [
    'readArgs',
    'writeArgs',
    'deleteArgs',
    'shellArgs',
    'shellStreamArgs',
    'lsArgs',
    'grepArgs',
    'fetchArgs',
  ]
  const passthrough = ['mcpArgs']
  const internal = ['requestContextArgs']

  if (redirectable.includes(execCase)) {
    return 'redirect'
  }
  if (passthrough.includes(execCase)) {
    return 'passthrough'
  }
  if (internal.includes(execCase)) {
    return 'internal'
  }
  return 'reject'
}
