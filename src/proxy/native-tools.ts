export const MCP_TOOL_PREFIX = 'mcp_pi_'

export function stripMcpToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
}

export function fixMcpArgNames(toolName: string, args: Record<string, unknown>): void {
  // For read/write/edit tools, Cursor sometimes sends 'path' instead of 'filePath'
  if (['read', 'write', 'edit'].includes(toolName) && args.path && !args.filePath) {
    args.filePath = args.path
    delete args.path
  }
}

export type ExecClassification = 'redirect' | 'passthrough' | 'internal' | 'reject'

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
