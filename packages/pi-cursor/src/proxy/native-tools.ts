import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'

import { create } from '@bufbuild/protobuf'

import type { ExecServerMessage, McpToolDefinition } from '../proto/agent_pb.ts'
import {
  DeleteResultSchema,
  DeleteSuccessSchema,
  FetchErrorSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepErrorSchema,
  GrepFileMatchSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsErrorSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadErrorSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellResultSchema,
  ShellSuccessSchema,
  WriteErrorSchema,
  WriteResultSchema,
  WriteSuccessSchema,
} from '../proto/agent_pb.ts'

/** Prefix Cursor uses for MCP tool names (e.g. `mcp_pi_read`). */
export const MCP_TOOL_PREFIX = 'mcp_pi_'

/** Removes the `mcp_pi_` prefix from a tool name, if present. */
export function stripMcpToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
}

/** Builds the enabled Pi tool set from Cursor MCP tool registrations. */
export function buildEnabledToolSet(mcpTools: McpToolDefinition[]): Set<string> {
  const enabledToolNames = new Set<string>()

  for (const tool of mcpTools) {
    const toolName = stripMcpToolPrefix(tool.toolName)
    if (toolName) {
      enabledToolNames.add(toolName)
    }
  }

  return enabledToolNames
}

/** Fixes argument name mismatches — Cursor sometimes sends `filePath` instead of `path`. */
export function fixMcpArgNames(toolName: string, args: Record<string, unknown>): void {
  // Cursor sometimes sends 'filePath' instead of 'path' for tools that expect 'path'
  if (['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(toolName) && args.filePath && !args.path) {
    args.path = args.filePath
    delete args.filePath
  }
}

/**
 * Exec cases that map to Pi tools via native redirection.
 * Shared between classifyExecMessage and nativeToMcpRedirect to prevent list drift.
 */
export const REDIRECTABLE_EXEC_CASES = new Set([
  'readArgs',
  'writeArgs',
  'deleteArgs',
  'shellArgs',
  'shellStreamArgs',
  'lsArgs',
  'grepArgs',
  'fetchArgs',
])

export type ExecClassification = 'redirect' | 'passthrough' | 'internal' | 'reject'

/** Classifies a Cursor exec message type for routing: redirect to Pi, pass through, handle internally, or reject. */
export function classifyExecMessage(execCase: string): ExecClassification {
  if (REDIRECTABLE_EXEC_CASES.has(execCase)) {
    return 'redirect'
  }
  if (execCase === 'mcpArgs') {
    return 'passthrough'
  }
  if (execCase === 'requestContextArgs') {
    return 'internal'
  }
  return 'reject'
}

// ---------------------------------------------------------------------------
// Allowed Root & Path Sandboxing
// ---------------------------------------------------------------------------

/**
 * Finds the nearest git root containing `cwd` by walking up directories
 * looking for `.git`. Falls back to `cwd` itself if no git repo is found.
 */
export function resolveAllowedRoot(cwd: string): string {
  let dir = resolve(cwd)
  for (;;) {
    try {
      if (existsSync(resolve(dir, '.git'))) {
        return dir
      }
    } catch {
      // Permission denied or inaccessible — stop walking
      return resolve(cwd)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      // Reached filesystem root — no git repo found
      return resolve(cwd)
    }
    dir = parent
  }
}

/**
 * Resolves a file path and verifies it falls within the allowed root.
 * Returns the resolved absolute path. Throws on path traversal violations.
 */
export function validatePath(filePath: string, allowedRoot: string): string {
  const resolved = isAbsolute(filePath) ? normalize(filePath) : resolve(allowedRoot, filePath)
  const normalizedRoot = normalize(allowedRoot)

  // Ensure the resolved path starts with the allowed root
  // Add separator to prevent /foo matching /foobar
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new Error(`Path '${filePath}' is outside the allowed root '${allowedRoot}'`)
  }

  return resolved
}

// ---------------------------------------------------------------------------
// Proxy-local native tool execution
// ---------------------------------------------------------------------------

export interface NativeExecResult {
  resultType: string
  result: unknown
}

/**
 * Execute a Cursor native tool call locally within the allowed root.
 * Returns the protobuf result to send back to Cursor's server.
 */
export async function executeNativeLocally(execMsg: ExecServerMessage, allowedRoot: string): Promise<NativeExecResult> {
  const msg = execMsg.message

  if (msg.case === 'readArgs') {
    return executeRead(msg.value, allowedRoot)
  }
  if (msg.case === 'writeArgs') {
    return executeWrite(msg.value, allowedRoot)
  }
  if (msg.case === 'deleteArgs') {
    return executeDelete(msg.value, allowedRoot)
  }
  if (msg.case === 'shellArgs' || msg.case === 'shellStreamArgs') {
    return executeShell(msg.value, allowedRoot, msg.case === 'shellStreamArgs')
  }
  if (msg.case === 'lsArgs') {
    return executeLs(msg.value, allowedRoot)
  }
  if (msg.case === 'grepArgs') {
    return executeGrep(msg.value, allowedRoot)
  }
  if (msg.case === 'fetchArgs') {
    return executeFetch(msg.value)
  }

  throw new Error(`Unsupported native exec case: ${msg.case}`)
}

async function executeRead(
  args: { path: string; offset?: number; limit?: number },
  allowedRoot: string,
): Promise<NativeExecResult> {
  try {
    const resolvedPath = validatePath(args.path, allowedRoot)
    const content = await readFile(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length
    const fileSize = Buffer.byteLength(content)

    let outputLines = lines
    let truncated = false
    if (args.offset || args.limit) {
      const start = (args.offset ?? 1) - 1 // 1-indexed
      const end = args.limit ? start + args.limit : undefined
      outputLines = lines.slice(Math.max(0, start), end)
      truncated = end !== undefined && end < totalLines
    }

    return {
      resultType: 'readResult',
      result: create(ReadResultSchema, {
        result: {
          case: 'success',
          value: create(ReadSuccessSchema, {
            path: args.path,
            totalLines,
            fileSize: BigInt(fileSize),
            truncated,
            output: { case: 'content', value: outputLines.join('\n') },
          }),
        },
      }),
    }
  } catch (error) {
    return {
      resultType: 'readResult',
      result: create(ReadResultSchema, {
        result: {
          case: 'error',
          value: create(ReadErrorSchema, {
            path: args.path,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    }
  }
}

async function executeWrite(
  args: { path: string; fileText: string; fileBytes: Uint8Array; toolCallId: string },
  allowedRoot: string,
): Promise<NativeExecResult> {
  try {
    const resolvedPath = validatePath(args.path, allowedRoot)
    const content = args.fileBytes.length > 0 ? new TextDecoder().decode(args.fileBytes) : args.fileText
    // Ensure parent directory exists
    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, content, 'utf-8')
    const lineCount = content.split('\n').length
    return {
      resultType: 'writeResult',
      result: create(WriteResultSchema, {
        result: {
          case: 'success',
          value: create(WriteSuccessSchema, {
            path: args.path,
            linesCreated: lineCount,
          }),
        },
      }),
    }
  } catch (error) {
    return {
      resultType: 'writeResult',
      result: create(WriteResultSchema, {
        result: {
          case: 'error',
          value: create(WriteErrorSchema, {
            path: args.path,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    }
  }
}

async function executeDelete(
  args: { path: string; toolCallId: string },
  allowedRoot: string,
): Promise<NativeExecResult> {
  try {
    if (!args.path) {
      // Empty path — no-op
      return {
        resultType: 'deleteResult',
        result: create(DeleteResultSchema, {
          result: {
            case: 'success',
            value: create(DeleteSuccessSchema, { path: '' }),
          },
        }),
      }
    }
    const resolvedPath = validatePath(args.path, allowedRoot)
    await unlink(resolvedPath)
    return {
      resultType: 'deleteResult',
      result: create(DeleteResultSchema, {
        result: {
          case: 'success',
          value: create(DeleteSuccessSchema, { path: args.path }),
        },
      }),
    }
  } catch {
    // Delete is best-effort — file not found is not an error
    return {
      resultType: 'deleteResult',
      result: create(DeleteResultSchema, {
        result: {
          case: 'success',
          value: create(DeleteSuccessSchema, { path: args.path }),
        },
      }),
    }
  }
}

function executeShell(
  args: { command: string; workingDirectory?: string; toolCallId: string },
  allowedRoot: string,
  isStream: boolean,
): Promise<NativeExecResult> {
  const resultType = isStream ? 'shellStreamResult' : 'shellResult'
  const cwd = args.workingDirectory ? validatePath(args.workingDirectory, allowedRoot) : allowedRoot

  return new Promise((resolvePromise) => {
    const startTime = Date.now()
    const child = spawn(args.command, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('close', (code, signal) => {
      const elapsed = Date.now() - startTime
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')

      resolvePromise({
        resultType,
        result: create(ShellResultSchema, {
          result: {
            case: 'success',
            value: create(ShellSuccessSchema, {
              command: args.command,
              workingDirectory: cwd,
              exitCode: code ?? 1,
              signal: signal ?? '',
              stdout,
              stderr,
              executionTime: elapsed,
            }),
          },
        }),
      })
    })

    child.on('error', (err) => {
      resolvePromise({
        resultType,
        result: create(ShellResultSchema, {
          result: {
            case: 'success',
            value: create(ShellSuccessSchema, {
              command: args.command,
              workingDirectory: cwd,
              exitCode: 1,
              stdout: '',
              stderr: err.message,
              executionTime: Date.now() - startTime,
            }),
          },
        }),
      })
    })
  })
}

async function executeLs(args: { path: string }, allowedRoot: string): Promise<NativeExecResult> {
  try {
    const resolvedPath = validatePath(args.path || '.', allowedRoot)
    const entries = await readdir(resolvedPath, { withFileTypes: true })
    const dirs: ReturnType<typeof create<typeof LsDirectoryTreeNodeSchema>>[] = []
    const files: ReturnType<typeof create<typeof LsDirectoryTreeNode_FileSchema>>[] = []

    for (const entry of entries) {
      const absPath = resolve(resolvedPath, entry.name)
      if (entry.isDirectory()) {
        dirs.push(create(LsDirectoryTreeNodeSchema, { absPath }))
      } else {
        files.push(create(LsDirectoryTreeNode_FileSchema, { name: entry.name }))
      }
    }

    return {
      resultType: 'lsResult',
      result: create(LsResultSchema, {
        result: {
          case: 'success',
          value: create(LsSuccessSchema, {
            directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
              absPath: resolvedPath,
              childrenDirs: dirs,
              childrenFiles: files,
            }),
          }),
        },
      }),
    }
  } catch (error) {
    return {
      resultType: 'lsResult',
      result: create(LsResultSchema, {
        result: {
          case: 'error',
          value: create(LsErrorSchema, {
            path: args.path,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    }
  }
}

async function executeGrep(args: { pattern: string; path?: string }, allowedRoot: string): Promise<NativeExecResult> {
  try {
    const searchPath = args.path ?? '.'
    const resolvedPath = validatePath(searchPath, allowedRoot)

    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn('grep', ['-rn', '--', args.pattern, resolvedPath], {
        cwd: allowedRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

      child.on('close', (code) => {
        // grep returns 1 for no matches (not an error)
        if (code === 0 || code === 1) {
          resolvePromise(Buffer.concat(chunks).toString('utf-8'))
        } else {
          reject(new Error(`grep exited with code ${code}`))
        }
      })

      child.on('error', reject)
    })

    // Parse grep -rn output into GrepFileMatch structure
    const fileMatchMap = new Map<string, ReturnType<typeof create<typeof GrepContentMatchSchema>>[]>()
    for (const line of output.split('\n')) {
      if (!line) {continue}
      // Format: file:line:content
      const firstColon = line.indexOf(':')
      if (firstColon === -1) {continue}
      const secondColon = line.indexOf(':', firstColon + 1)
      if (secondColon === -1) {continue}
      const file = line.slice(0, firstColon)
      const lineNum = Number.parseInt(line.slice(firstColon + 1, secondColon), 10)
      const content = line.slice(secondColon + 1)
      if (!Number.isFinite(lineNum)) {continue}

      let matches = fileMatchMap.get(file)
      if (!matches) {
        matches = []
        fileMatchMap.set(file, matches)
      }
      matches.push(create(GrepContentMatchSchema, { lineNumber: lineNum, content }))
    }

    const fileMatches = [...fileMatchMap.entries()].map(([file, matches]) =>
      create(GrepFileMatchSchema, { file, matches }),
    )

    return {
      resultType: 'grepResult',
      result: create(GrepResultSchema, {
        result: {
          case: 'success',
          value: create(GrepSuccessSchema, {
            pattern: args.pattern,
            path: searchPath,
            outputMode: 'content',
            workspaceResults: {
              default: create(GrepUnionResultSchema, {
                result: {
                  case: 'content',
                  value: create(GrepContentResultSchema, { matches: fileMatches }),
                },
              }),
            },
          }),
        },
      }),
    }
  } catch (error) {
    return {
      resultType: 'grepResult',
      result: create(GrepResultSchema, {
        result: {
          case: 'error',
          value: create(GrepErrorSchema, {
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    }
  }
}

async function executeFetch(args: { url: string; toolCallId: string }): Promise<NativeExecResult> {
  try {
    const response = await fetch(args.url)
    const content = await response.text()
    return {
      resultType: 'fetchResult',
      result: create(FetchResultSchema, {
        result: {
          case: 'success',
          value: create(FetchSuccessSchema, {
            url: args.url,
            content,
            statusCode: response.status,
            contentType: response.headers.get('content-type') ?? '',
          }),
        },
      }),
    }
  } catch (error) {
    return {
      resultType: 'fetchResult',
      result: create(FetchResultSchema, {
        result: {
          case: 'error',
          value: create(FetchErrorSchema, {
            url: args.url,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    }
  }
}
