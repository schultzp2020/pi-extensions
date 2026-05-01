import { create } from '@bufbuild/protobuf'

import type { McpToolDefinition } from '../proto/agent_pb.ts'
import { McpInstructionsSchema, RequestContextSchema } from '../proto/agent_pb.ts'

const MCP_SERVER_NAME = 'pi'
const MCP_INSTRUCTIONS =
  'This environment provides tools prefixed with mcp_pi_ (e.g. mcp_pi_read, ' +
  'mcp_pi_grep, mcp_pi_bash). Always prefer these mcp_pi_* tools over any ' +
  'built-in native tools.'

/** Builds a Cursor RequestContext with MCP tool definitions and an optional system prompt via cloudRule. */
export function buildRequestContext(mcpTools: McpToolDefinition[], cloudRule?: string) {
  return create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools: mcpTools,
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [
      create(McpInstructionsSchema, {
        serverName: MCP_SERVER_NAME,
        instructions: MCP_INSTRUCTIONS,
      }),
    ],
    cloudRule: cloudRule ?? undefined,
    fileContents: {},
    customSubagents: [],
  })
}
