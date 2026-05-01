# pi-cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Pi extension that provides access to all Cursor subscription models inside Pi via a shared local OpenAI-compatible proxy with automatic model discovery, OAuth login, and full tool-call support.

**Architecture:** A standalone Node.js proxy process translates OpenAI-format requests into Cursor's gRPC/protobuf Connect protocol over HTTP/2. A Pi extension manages the proxy lifecycle (spawn, reconnect, shutdown), handles OAuth authentication via `/login cursor`, and registers discovered models as a custom provider using `openai-completions` API. Multiple Pi sessions share one proxy via HTTP internal API, with session isolation via headers.

**Tech Stack:** TypeScript, Node.js (`node:http2`, `node:crypto`, `node:fs`), `@bufbuild/protobuf` (protobuf serialization), Pi extension API (`@mariozechner/pi-coding-agent`), `@bufbuild/buf` (proto generation, dev only), Vitest (testing), oxlint + oxfmt (linting/formatting), husky + lint-staged (pre-commit)

**Reference implementations:**

- `ephraimduncan/opencode-cursor` (MIT) — original OpenCode plugin
- `Hardcode84/opencode-cursor` branch `cursor-persists` — improved fork with `.proto` source, batch state machine, native tool redirection, disk persistence, tests
- See `CONTEXT.md` and `docs/adr/` for all design decisions

**Parallelization:** Tasks are organized into phases. Tasks within the same phase have no dependencies on each other and should be dispatched to parallel agents. Each phase depends on all prior phases being complete.

```
Phase 1: Scaffolding (Task 1)
    │
Phase 2: Pure utilities — all independent, run in parallel
    ├── Task 2: Connect protocol framing
    ├── Task 3: Event queue
    ├── Task 4: Thinking tag filter
    ├── Task 5: OpenAI message parsing
    ├── Task 6: Conversation state persistence
    ├── Task 7: Request context builder
    ├── Task 8: Native tool redirection
    └── Task 9: PKCE and OAuth auth
    │
Phase 3: Protocol layer — sequential within phase
    ├── Task 10: Cursor message processing (depends on 2, 7, 8)
    ├── Task 11: CursorSession (depends on 2, 3, 10)
    ├── Task 12: OpenAI SSE stream writer (depends on 4, 11)
    ├── Task 13: Session manager (depends on 5, 11)
    └── Task 14: Model discovery (depends on 11)
    │
Phase 4: Server + extension — can partially parallel
    ├── Task 15: Internal API (depends on 14)
    ├── Task 16: Proxy HTTP server (depends on 10-15)
    ├── Task 17: Proxy lifecycle (depends on 14)
    └── Task 18: Extension entry point (depends on 9, 17)
    │
Phase 5: Task 19: Integration testing
```

---

## File Structure

```
pi-cursor/
├── package.json                    # Extension package metadata + dependencies
├── tsconfig.json                   # TypeScript config
├── CONTEXT.md                      # Domain language (exists)
├── docs/adr/                       # Architecture decisions (exists)
├── proto/
│   ├── agent.proto                 # Cursor AgentService proto (vendored)
│   └── aiserver.proto              # Cursor AiService proto (vendored)
├── buf.yaml                        # Buf module config
├── buf.gen.yaml                    # Buf codegen config
├── src/
│   ├── index.ts                    # Extension entry point — factory, OAuth, provider registration
│   ├── proxy-lifecycle.ts          # Spawn, discover, reconnect, shutdown proxy process
│   ├── proxy/
│   │   ├── main.ts                 # Proxy entry point — HTTP server, route dispatch
│   │   ├── internal-api.ts         # /internal/* endpoints (heartbeat, token, health, refresh-models)
│   │   ├── session-manager.ts      # Active CursorSession map, session isolation by X-Session-Id
│   │   ├── cursor-session.ts       # CursorSession class — H2 connection, batch state machine, event queue
│   │   ├── event-queue.ts          # Generic async event queue
│   │   ├── event-queue.test.ts     # Tests colocated with source
│   │   ├── cursor-messages.ts      # Cursor protobuf message processing (interaction, KV, exec dispatch)
│   │   ├── native-tools.ts         # Native tool redirection + rejection, result formatting
│   │   ├── native-tools.test.ts
│   │   ├── request-context.ts      # Build RequestContext with MCP tools + cloud rule
│   │   ├── openai-messages.ts      # Parse OpenAI message format → internal types
│   │   ├── openai-messages.test.ts
│   │   ├── openai-stream.ts        # SSE writer — consume session events, emit OpenAI chunks
│   │   ├── conversation-state.ts   # Checkpoint/blob persistence to disk, TTL eviction
│   │   ├── conversation-state.test.ts
│   │   ├── connect-protocol.ts     # Connect framing (encode/decode/parse)
│   │   ├── connect-protocol.test.ts
│   │   ├── thinking-filter.ts      # XML thinking tag filter
│   │   ├── thinking-filter.test.ts
│   │   └── models.ts              # Model discovery (AvailableModels + GetUsableModels gRPC)
│   ├── auth.ts                     # Cursor PKCE OAuth flow (generate params, poll, refresh)
│   ├── pkce.ts                     # PKCE challenge/verifier generation
│   └── proto/                      # Generated protobuf types (from buf generate)
│       ├── agent_pb.ts
│       └── aiserver_pb.ts
```

---

## Task 1: Project scaffolding, tooling, and proto generation

**Phase: 1 (sequential — must complete before all other tasks)**

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.oxlintrc.json`
- Create: `.oxfmtrc.json`
- Modify: `.husky/pre-commit` (created by `npx husky init`)
- Create: `proto/aiserver.proto` (vendored from Hardcode84 fork)
- Create: `buf.yaml`
- Create: `buf.gen.yaml`
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "pi-cursor",
  "version": "0.1.0",
  "description": "Pi extension for Cursor subscription models via local OpenAI-compatible proxy",
  "type": "module",
  "private": true,
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "scripts": {
    "generate": "npx @bufbuild/buf generate",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "lint": "oxlint --type-aware --type-check --deny-warnings .",
    "lint:fix": "oxlint --type-aware --type-check --fix .",
    "prepare": "husky"
  },
  "lint-staged": {
    "*.ts": ["oxfmt", "oxlint --type-aware --type-check --deny-warnings --fix", "vitest related --run"],
    "*.{json,md}": "oxfmt"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.0.0"
  },
  "devDependencies": {
    "@bufbuild/buf": "^1.50.0",
    "@bufbuild/protoc-gen-es": "^2.10.0",
    "@mariozechner/pi-coding-agent": "^0.71.1",
    "@types/node": "^22.0.0",
    "husky": "^9.1.7",
    "lint-staged": "^16.4.0",
    "oxfmt": "^0.47.0",
    "oxlint": "^1.62.0",
    "oxlint-tsgolint": "^0.22.1",
    "typescript": "^5.9.0",
    "vitest": "^4.1.5"
  }
}
```

Note: `@mariozechner/pi-coding-agent` is pinned to `^0.71.1` (current release). Pi is pre-1.0 so minor versions can have breaking changes, but the `^` range allows patch updates. Pin more tightly if stability issues arise.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `.oxlintrc.json` with strict rules**

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
  "rules": {
    "eslint/eqeqeq": "warn",
    "eslint/no-self-compare": "warn",
    "eslint/no-template-curly-in-string": "warn",
    "eslint/prefer-const": "warn",
    "eslint/no-var": "warn",
    "eslint/prefer-template": "warn",
    "eslint/object-shorthand": "warn",
    "eslint/prefer-rest-params": "warn",
    "eslint/prefer-spread": "warn",
    "eslint/prefer-destructuring": "warn",
    "eslint/prefer-exponentiation-operator": "warn",
    "eslint/prefer-object-spread": "warn",
    "eslint/prefer-object-has-own": "warn",
    "eslint/prefer-numeric-literals": "warn",
    "eslint/prefer-promise-reject-errors": "warn",
    "eslint/arrow-body-style": "warn",
    "eslint/no-useless-constructor": "warn",
    "eslint/no-useless-computed-key": "warn",
    "eslint/array-callback-return": "warn",
    "eslint/no-fallthrough": "warn",
    "eslint/no-promise-executor-return": "warn",
    "eslint/no-else-return": "warn",
    "eslint/curly": "warn",
    "eslint/default-case-last": "warn",
    "eslint/default-param-last": "warn",
    "eslint/no-lonely-if": "warn",
    "eslint/symbol-description": "warn",
    "eslint/sort-imports": "off",
    "eslint/no-eval": "warn",
    "eslint/no-new-func": "warn",
    "eslint/radix": "warn",

    "typescript/no-explicit-any": "warn",
    "typescript/consistent-type-imports": "warn",
    "typescript/no-non-null-assertion": "warn",
    "typescript/prefer-optional-chain": "warn",
    "typescript/no-unnecessary-condition": "warn",
    "typescript/no-deprecated": "warn",
    "typescript/return-await": "warn",
    "typescript/array-type": "warn",
    "typescript/consistent-type-definitions": "warn",
    "typescript/consistent-generic-constructors": "warn",
    "typescript/prefer-for-of": "warn",
    "typescript/prefer-find": "warn",
    "typescript/prefer-string-starts-ends-with": "warn",
    "typescript/prefer-includes": "warn",
    "typescript/prefer-nullish-coalescing": "warn",
    "typescript/no-var-requires": "warn",
    "typescript/await-thenable": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-for-in-array": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/require-await": "warn",
    "typescript/restrict-plus-operands": "error",
    "typescript/switch-exhaustiveness-check": "warn",

    "import/no-cycle": "warn",
    "import/no-duplicates": "warn",

    "promise/no-return-in-finally": "warn",
    "promise/catch-or-return": "warn",

    "unicorn/prefer-includes": "warn",
    "unicorn/prefer-array-flat-map": "warn",
    "unicorn/prefer-array-flat": "warn",
    "unicorn/prefer-array-some": "warn",
    "unicorn/prefer-array-find": "warn",
    "unicorn/prefer-at": "warn",
    "unicorn/prefer-string-slice": "warn",
    "unicorn/prefer-string-replace-all": "warn",
    "unicorn/prefer-string-trim-start-end": "warn",
    "unicorn/prefer-number-properties": "warn",
    "unicorn/prefer-modern-math-apis": "warn",
    "unicorn/prefer-node-protocol": "warn",
    "unicorn/prefer-structured-clone": "warn",
    "unicorn/prefer-set-has": "warn",
    "unicorn/prefer-spread": "warn",
    "unicorn/prefer-code-point": "warn",
    "unicorn/prefer-date-now": "warn",
    "unicorn/prefer-event-target": "warn",
    "unicorn/prefer-global-this": "warn",
    "unicorn/no-instanceof-array": "warn",
    "unicorn/throw-new-error": "warn",
    "unicorn/error-message": "warn",
    "unicorn/no-negation-in-equality-check": "warn",
    "unicorn/switch-case-braces": "warn",
    "unicorn/catch-error-name": "warn",

    "vitest/prefer-to-be-truthy": "warn",
    "vitest/prefer-to-be-falsy": "warn"
  },
  "ignorePatterns": ["**/node_modules", "**/dist", "**/src/proto/**"]
}
```

The `src/proto/**` directory is ignored because vendored/generated proto types don't conform to our lint rules.

- [ ] **Step 4: Create `.oxfmtrc.json`**

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 120,
  "singleQuote": true,
  "semi": false,
  "trailingComma": "all",
  "endOfLine": "lf",
  "ignorePatterns": ["dist/", "node_modules/", "src/proto/"],
  "sortImports": {
    "groups": ["builtin", "external", "internal", ["parent", "sibling", "index"], "unknown"],
    "newlinesBetween": true
  },
  "sortPackageJson": true
}
```

See https://oxc.rs/docs/guide/usage/linter/type-aware.html for type-aware configuration. Type-aware linting uses `oxlint-tsgolint` which reads the `tsconfig.json` for project context.

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: Run npm install**

Run: `npm install`

- [ ] **Step 7: Set up husky + lint-staged**

Run: `npx husky init`

Then replace `.husky/pre-commit` contents:

```bash
npx lint-staged
```

- [ ] **Step 8: Verify tooling works**

Run: `npm run lint`
Expected: No errors (no source files yet).

Run: `npm run fmt:check`
Expected: No errors (no source files yet).

Run: `npm test`
Expected: No tests found (expected at this point).

- [ ] **Step 9: Vendor proto files**

Fetch `proto/aiserver.proto` from `Hardcode84/opencode-cursor` branch `cursor-persists`. This contains `AvailableModelsRequest`/`AvailableModelsResponse` for model discovery (49 lines).

**For the agent proto:** vendor the generated `src/proto/agent_pb.ts` directly from the Hardcode84 fork (~15,274 lines) rather than reconstructing the `.proto` source. This avoids blocking on proto reconstruction. The `aiserver.proto` is small and can be generated normally via buf.

- [ ] **Step 10: Create buf.yaml**

```yaml
version: v2
modules:
  - path: proto
```

- [ ] **Step 11: Create buf.gen.yaml**

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: src/proto
    opt: target=ts
inputs:
  - directory: proto
```

- [ ] **Step 12: Generate aiserver proto types**

Run: `npm run generate`
Expected: `src/proto/aiserver_pb.ts` is created.

- [ ] **Step 13: Copy vendored agent_pb.ts**

Fetch `src/proto/agent_pb.ts` from the Hardcode84 fork and save to `src/proto/agent_pb.ts`.

- [ ] **Step 14: Verify proto imports work**

Create a temporary test file:

```typescript
// src/proto/proto-smoke.test.ts
import { describe, it, expect } from 'vitest'
import { AvailableModelsRequestSchema } from './aiserver_pb.ts'
import { AgentRunRequestSchema } from './agent_pb.ts'

describe('proto smoke test', () => {
  it('imports aiserver proto types', () => {
    expect(AvailableModelsRequestSchema).toBeDefined()
  })

  it('imports agent proto types', () => {
    expect(AgentRunRequestSchema).toBeDefined()
  })
})
```

Run: `npm test`
Expected: 2 tests pass.

- [ ] **Step 15: Commit**

```bash
git add .
git commit -m "feat: project scaffolding with oxlint, oxfmt, husky, vitest, and proto generation"
```

---

## Task 2: Connect protocol framing

**Phase: 2 (parallel with Tasks 3–9)**

**Files:**

- Create: `src/proxy/connect-protocol.ts`
- Create: `src/proxy/connect-protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/connect-protocol.test.ts
import { describe, it, expect } from 'vitest'
import {
  frameConnectMessage,
  createConnectFrameParser,
  parseConnectEndStream,
  decodeConnectUnaryBody,
  CONNECT_END_STREAM_FLAG,
} from './connect-protocol.ts'

describe('frameConnectMessage', () => {
  it('creates a 5-byte header + payload', () => {
    const data = new TextEncoder().encode('hello')
    const frame = frameConnectMessage(data)
    expect(frame[0]).toBe(0) // flags = 0
    expect(frame.readUInt32BE(1)).toBe(5) // length
    expect(frame.subarray(5)).toEqual(Buffer.from(data))
  })

  it('sets flags when provided', () => {
    const data = new Uint8Array([1, 2, 3])
    const frame = frameConnectMessage(data, CONNECT_END_STREAM_FLAG)
    expect(frame[0]).toBe(CONNECT_END_STREAM_FLAG)
  })
})

describe('createConnectFrameParser', () => {
  it('parses a single complete frame', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const data = new TextEncoder().encode('test')
    const frame = frameConnectMessage(data)
    parser(Buffer.from(frame))
    expect(messages).toHaveLength(1)
    expect(Buffer.from(messages[0]!)).toEqual(Buffer.from(data))
  })

  it('handles partial frames across multiple chunks', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const data = new TextEncoder().encode('hello world')
    const frame = frameConnectMessage(data)
    const mid = Math.floor(frame.length / 2)
    parser(Buffer.from(frame.subarray(0, mid)))
    expect(messages).toHaveLength(0) // not yet complete
    parser(Buffer.from(frame.subarray(mid)))
    expect(messages).toHaveLength(1)
  })

  it('routes end-stream frames to onEndStream', () => {
    const endStreams: Uint8Array[] = []
    const parser = createConnectFrameParser(
      () => {},
      (bytes) => endStreams.push(bytes),
    )
    const data = new TextEncoder().encode('{"error":{"code":"internal"}}')
    const frame = frameConnectMessage(data, CONNECT_END_STREAM_FLAG)
    parser(Buffer.from(frame))
    expect(endStreams).toHaveLength(1)
  })

  it('parses multiple frames in one chunk', () => {
    const messages: Uint8Array[] = []
    const parser = createConnectFrameParser(
      (bytes) => messages.push(bytes),
      () => {},
    )
    const frame1 = frameConnectMessage(new TextEncoder().encode('one'))
    const frame2 = frameConnectMessage(new TextEncoder().encode('two'))
    parser(Buffer.concat([Buffer.from(frame1), Buffer.from(frame2)]))
    expect(messages).toHaveLength(2)
  })
})

describe('parseConnectEndStream', () => {
  it('returns Error for error payloads', () => {
    const data = new TextEncoder().encode(JSON.stringify({ error: { code: 'internal', message: 'Blob not found' } }))
    const err = parseConnectEndStream(data)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('internal')
    expect(err!.message).toContain('Blob not found')
  })

  it('returns null for clean end stream', () => {
    const data = new TextEncoder().encode(JSON.stringify({}))
    expect(parseConnectEndStream(data)).toBeNull()
  })
})

describe('decodeConnectUnaryBody', () => {
  it('extracts payload from a single data frame', () => {
    const payload = new TextEncoder().encode('protobuf-bytes')
    const frame = frameConnectMessage(payload)
    const result = decodeConnectUnaryBody(new Uint8Array(frame))
    expect(result).not.toBeNull()
    expect(Buffer.from(result!)).toEqual(Buffer.from(payload))
  })

  it('returns null for too-short input', () => {
    expect(decodeConnectUnaryBody(new Uint8Array([1, 2]))).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/connect-protocol.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement connect-protocol.ts**

```typescript
// src/proxy/connect-protocol.ts
export const CONNECT_END_STREAM_FLAG = 0b00000010
const MAX_FRAME_SIZE = 32 * 1024 * 1024 // 32 MiB

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, Buffer.from(data)])
}

export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0)
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming])
    while (pending.length >= 5) {
      const flags = pending[0]!
      const msgLen = pending.readUInt32BE(1)
      if (msgLen > MAX_FRAME_SIZE) {
        pending = Buffer.alloc(0)
        onEndStream(
          new TextEncoder().encode(
            JSON.stringify({
              error: { code: 'frame_too_large', message: `Frame size ${msgLen} exceeds limit` },
            }),
          ),
        )
        return
      }
      if (pending.length < 5 + msgLen) break
      const messageBytes = pending.subarray(5, 5 + msgLen)
      pending = pending.subarray(5 + msgLen)
      if (flags & CONNECT_END_STREAM_FLAG) {
        onEndStream(messageBytes)
      } else {
        onMessage(messageBytes)
      }
    }
  }
}

export function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null
  let offset = 0
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset)
    const messageLength = view.getUint32(1, false)
    const frameEnd = offset + 5 + messageLength
    if (frameEnd > payload.length) return null
    if ((flags & 0b0000_0001) !== 0) return null // compressed
    if ((flags & CONNECT_END_STREAM_FLAG) === 0) {
      return payload.subarray(offset + 5, frameEnd)
    }
    offset = frameEnd
  }
  return null
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data))
    const error = payload?.error
    if (error) {
      const code = error.code ?? 'unknown'
      const message = error.message ?? 'Unknown error'
      return new Error(`Connect error ${code}: ${message}`)
    }
    return null
  } catch {
    return new Error('Failed to parse Connect end stream')
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/connect-protocol.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/connect-protocol.ts src/proxy/connect-protocol.test.ts
git commit -m "feat: Connect protocol framing (encode/decode/parse)"
```

---

## Task 3: Event queue

**Phase: 2 (parallel with Tasks 2, 4–9)**

**Files:**

- Create: `src/proxy/event-queue.ts`
- Create: `src/proxy/event-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/event-queue.test.ts
import { describe, it, expect } from 'vitest'
import { EventQueue, MAX_QUEUE_DEPTH } from './event-queue.ts'

describe('EventQueue', () => {
  it('delivers buffered events via next()', async () => {
    const q = new EventQueue<string>()
    q.push('a')
    q.push('b')
    expect(await q.next()).toBe('a')
    expect(await q.next()).toBe('b')
  })

  it('waits for events when buffer is empty', async () => {
    const q = new EventQueue<string>()
    const promise = q.next()
    q.push('delayed')
    expect(await promise).toBe('delayed')
  })

  it('delivers directly to waiter without buffering', async () => {
    const q = new EventQueue<number>()
    const promise = q.next()
    q.push(42)
    expect(await promise).toBe(42)
    expect(q.length).toBe(0)
  })

  it('calls onOverflow when buffer exceeds MAX_QUEUE_DEPTH', () => {
    let overflowed = false
    const q = new EventQueue<number>({
      onOverflow: () => {
        overflowed = true
      },
    })
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      q.push(i)
    }
    expect(overflowed).toBe(false)
    const accepted = q.push(MAX_QUEUE_DEPTH)
    expect(accepted).toBe(false)
    expect(overflowed).toBe(true)
  })

  it('pushForce bypasses overflow limit', () => {
    const q = new EventQueue<number>()
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) q.push(i)
    q.pushForce(-1)
    expect(q.length).toBe(MAX_QUEUE_DEPTH + 1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/event-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement event-queue.ts**

```typescript
// src/proxy/event-queue.ts
export const MAX_QUEUE_DEPTH = 10_000

export class EventQueue<T> {
  private buffer: T[] = []
  private waiters: Array<(value: T) => void> = []
  private overflowCb?: () => void

  constructor(opts?: { onOverflow?: () => void }) {
    this.overflowCb = opts?.onOverflow
  }

  get length(): number {
    return this.buffer.length
  }

  push(event: T): boolean {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(event)
      return true
    }
    if (this.buffer.length >= MAX_QUEUE_DEPTH) {
      this.overflowCb?.()
      return false
    }
    this.buffer.push(event)
    return true
  }

  pushForce(event: T): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(event)
    } else {
      this.buffer.push(event)
    }
  }

  next(): Promise<T> {
    const head = this.buffer.shift()
    if (head !== undefined) return Promise.resolve(head)
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/event-queue.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/event-queue.ts src/proxy/event-queue.test.ts
git commit -m "feat: async event queue with overflow protection"
```

---

## Task 4: Thinking tag filter

**Phase: 2 (parallel with Tasks 2–3, 5–9)**

**Files:**

- Create: `src/proxy/thinking-filter.ts`
- Create: `src/proxy/thinking-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/thinking-filter.test.ts
import { describe, it, expect } from 'vitest'
import { createThinkingTagFilter } from './thinking-filter.ts'

describe('createThinkingTagFilter', () => {
  it('passes plain text through as content', () => {
    const filter = createThinkingTagFilter()
    const result = filter.process('hello world')
    expect(result.content).toBe('hello world')
    expect(result.reasoning).toBe('')
  })

  it('routes <thinking> tagged content to reasoning', () => {
    const filter = createThinkingTagFilter()
    const r1 = filter.process('<thinking>let me think')
    expect(r1.content).toBe('')
    expect(r1.reasoning).toBe('let me think')
    const r2 = filter.process('</thinking>answer')
    expect(r2.content).toBe('answer')
    expect(r2.reasoning).toBe('')
  })

  it('handles all tag variants', () => {
    for (const tag of ['think', 'thinking', 'reasoning', 'thought', 'think_intent']) {
      const filter = createThinkingTagFilter()
      const r = filter.process(`<${tag}>inside</${tag}>outside`)
      expect(r.reasoning).toBe('inside')
      expect(r.content).toBe('outside')
    }
  })

  it('buffers partial tags across chunks', () => {
    const filter = createThinkingTagFilter()
    const r1 = filter.process('before<thi')
    expect(r1.content).toBe('before')
    expect(r1.reasoning).toBe('')
    const r2 = filter.process('nking>inside</thinking>after')
    expect(r2.reasoning).toBe('inside')
    expect(r2.content).toBe('after')
  })

  it('flush() emits buffered content', () => {
    const filter = createThinkingTagFilter()
    filter.process('text<thi')
    const flushed = filter.flush()
    expect(flushed.content).toBe('<thi')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/thinking-filter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement thinking-filter.ts**

```typescript
// src/proxy/thinking-filter.ts
const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent']
const MAX_THINKING_TAG_LEN = 16

export function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string }
  flush(): { content: string; reasoning: string }
} {
  let buffer = ''
  let inThinking = false

  return {
    process(text: string) {
      const input = buffer + text
      buffer = ''
      let content = ''
      let reasoning = ''
      let lastIdx = 0

      const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join('|')})\\s*>`, 'gi')
      let match: RegExpExecArray | null
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index)
        if (inThinking) reasoning += before
        else content += before
        inThinking = match[1] !== '/'
        lastIdx = re.lastIndex
      }

      const rest = input.slice(lastIdx)
      const ltPos = rest.lastIndexOf('<')
      if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
        buffer = rest.slice(ltPos)
        const before = rest.slice(0, ltPos)
        if (inThinking) reasoning += before
        else content += before
      } else {
        if (inThinking) reasoning += rest
        else content += rest
      }

      return { content, reasoning }
    },
    flush() {
      const b = buffer
      buffer = ''
      if (!b) return { content: '', reasoning: '' }
      return inThinking ? { content: '', reasoning: b } : { content: b, reasoning: '' }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/thinking-filter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/thinking-filter.ts src/proxy/thinking-filter.test.ts
git commit -m "feat: XML thinking tag filter for streamed text"
```

---

## Task 5: OpenAI message parsing

**Phase: 2 (parallel with Tasks 2–4, 6–9)**

**Files:**

- Create: `src/proxy/openai-messages.ts`
- Create: `src/proxy/openai-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/openai-messages.test.ts
import { describe, it, expect } from 'vitest'
import { parseMessages, textContent, selectToolsForChoice } from './openai-messages.ts'
import type { OpenAIMessage, OpenAIToolDef } from './openai-messages.ts'

describe('textContent', () => {
  it('handles string content', () => {
    expect(textContent('hello')).toBe('hello')
  })

  it('handles null content', () => {
    expect(textContent(null)).toBe('')
  })

  it('handles content parts array', () => {
    const parts = [{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }]
    expect(textContent(parts)).toBe('hello\nworld')
  })
})

describe('parseMessages', () => {
  it('extracts system prompt', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    const result = parseMessages(messages)
    expect(result.systemPrompt).toBe('You are helpful.')
    expect(result.userText).toBe('Hi')
  })

  it('extracts tool results', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Do something' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{"path":"f.ts"}' } }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc1' },
    ]
    const result = parseMessages(messages)
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]!.toolCallId).toBe('tc1')
    expect(result.toolResults[0]!.content).toBe('file contents')
  })

  it('builds conversation turns from user/assistant pairs', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]
    const result = parseMessages(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.userText).toBe('First question')
    expect(result.turns[0]!.assistantText).toBe('First answer')
    expect(result.userText).toBe('Second question')
  })
})

describe('selectToolsForChoice', () => {
  const tools: OpenAIToolDef[] = [
    { type: 'function', function: { name: 'read', description: 'Read a file' } },
    { type: 'function', function: { name: 'write', description: 'Write a file' } },
  ]

  it('returns all tools for auto/required/undefined', () => {
    expect(selectToolsForChoice(tools, 'auto')).toHaveLength(2)
    expect(selectToolsForChoice(tools, 'required')).toHaveLength(2)
    expect(selectToolsForChoice(tools, undefined)).toHaveLength(2)
  })

  it('returns empty for none', () => {
    expect(selectToolsForChoice(tools, 'none')).toHaveLength(0)
  })

  it('filters to specific function', () => {
    const result = selectToolsForChoice(tools, { type: 'function', function: { name: 'read' } })
    expect(result).toHaveLength(1)
    expect(result[0]!.function.name).toBe('read')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/openai-messages.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement openai-messages.ts**

Port `openai-messages.ts` from the Hardcode84 fork. This is a pure, side-effect-free module (~168 lines) containing:

- `OpenAIMessage`, `OpenAIToolDef`, `OpenAIToolCall`, `ContentPart`, `ToolResultInfo`, `ParsedMessages` type definitions
- `textContent()` — normalize message content to plain string
- `parseMessages()` — extract system prompt, turns, user text, and tool results from OpenAI message array
- `selectToolsForChoice()` — filter tools based on `tool_choice` parameter

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/openai-messages.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/openai-messages.ts src/proxy/openai-messages.test.ts
git commit -m "feat: OpenAI message parsing and tool choice filtering"
```

---

## Task 6: Conversation state persistence

**Phase: 2 (parallel with Tasks 2–5, 7–9)**

**Files:**

- Create: `src/proxy/conversation-state.ts`
- Create: `src/proxy/conversation-state.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/conversation-state.test.ts
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getConversationState,
  persistConversation,
  resolveConversationState,
  invalidateConversationState,
  type StoredConversation,
} from './conversation-state.ts'

const TEST_DIR = join(tmpdir(), `pi-cursor-test-${process.pid}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  invalidateConversationState('test-key')
})

describe('conversation-state', () => {
  it('creates a fresh conversation when none exists', () => {
    const stored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(stored.conversationId).toBeTruthy()
    expect(stored.checkpoint).toBeNull()
    expect(stored.blobStore.size).toBe(0)
  })

  it('persists and restores from disk', () => {
    const stored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    stored.checkpoint = new Uint8Array([1, 2, 3])
    stored.blobStore.set('abc', new Uint8Array([4, 5, 6]))
    persistConversation('test-key', stored, { conversationDiskDir: TEST_DIR })

    // Clear in-memory cache
    invalidateConversationState('test-key')

    // Should restore from disk
    const restored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(Buffer.from(restored.checkpoint!)).toEqual(Buffer.from([1, 2, 3]))
    expect(Buffer.from(restored.blobStore.get('abc')!)).toEqual(Buffer.from([4, 5, 6]))
    expect(restored.conversationId).toBe(stored.conversationId)
  })

  it('returns same instance from in-memory cache', () => {
    const a = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    const b = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(a).toBe(b) // same reference
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/conversation-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conversation-state.ts**

Port from the Hardcode84 fork (~246 lines). Key functions:

- `resolveConversationState(convKey, config)` — returns cached or disk-loaded or fresh `StoredConversation`
- `persistConversation(convKey, stored, config)` — atomic write to disk (temp file + rename)
- `getConversationState(convKey)` — get from in-memory cache only
- `invalidateConversationState(convKey)` — remove from cache
- `evictStaleConversations()` — TTL-based cleanup

The `StoredConversation` type:

```typescript
export interface StoredConversation {
  conversationId: string
  checkpoint: Uint8Array | null
  blobStore: Map<string, Uint8Array>
  lastAccessMs: number
  checkpointHistory: Map<string, Uint8Array>
  checkpointArchive: Map<string, Uint8Array>
}
```

Disk format: JSON with base64-encoded binary fields, written atomically via temp file + `renameSync`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/conversation-state.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/conversation-state.ts src/proxy/conversation-state.test.ts
git commit -m "feat: conversation state persistence to disk"
```

---

## Task 7: Request context builder

**Phase: 2 (parallel with Tasks 2–6, 8–9)**

**Files:**

- Create: `src/proxy/request-context.ts`

- [ ] **Step 1: Implement request-context.ts**

```typescript
// src/proxy/request-context.ts
import { create } from '@bufbuild/protobuf'
import { McpInstructionsSchema, type McpToolDefinition, RequestContextSchema } from '../proto/agent_pb.ts'

const MCP_SERVER_NAME = 'pi'
const MCP_INSTRUCTIONS =
  'This environment provides tools prefixed with mcp_pi_ (e.g. mcp_pi_read, ' +
  'mcp_pi_grep, mcp_pi_bash). Always prefer these mcp_pi_* tools over any ' +
  'built-in native tools.'

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
    cloudRule: cloudRule || undefined,
    fileContents: {},
    customSubagents: [],
  })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/proxy/request-context.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/request-context.ts
git commit -m "feat: RequestContext builder with MCP tools and cloud rule"
```

---

## Task 8: Native tool redirection

**Phase: 2 (parallel with Tasks 2–7, 9)**

**Files:**

- Create: `src/proxy/native-tools.ts`
- Create: `src/proxy/native-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/proxy/native-tools.test.ts
import { describe, it, expect } from 'vitest'
import { classifyExecMessage, MCP_TOOL_PREFIX, stripMcpToolPrefix, fixMcpArgNames } from './native-tools.ts'

describe('stripMcpToolPrefix', () => {
  it('strips the prefix', () => {
    expect(stripMcpToolPrefix(`${MCP_TOOL_PREFIX}read`)).toBe('read')
  })

  it('returns unchanged if no prefix', () => {
    expect(stripMcpToolPrefix('read')).toBe('read')
  })
})

describe('fixMcpArgNames', () => {
  it('renames path to filePath for read', () => {
    const args: Record<string, unknown> = { path: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.filePath).toBe('foo.ts')
    expect(args.path).toBeUndefined()
  })

  it('does not overwrite existing filePath', () => {
    const args: Record<string, unknown> = { filePath: 'bar.ts', path: 'foo.ts' }
    fixMcpArgNames('read', args)
    expect(args.filePath).toBe('bar.ts')
  })

  it('renames path to filePath for write', () => {
    const args: Record<string, unknown> = { path: 'out.ts', content: 'hello' }
    fixMcpArgNames('write', args)
    expect(args.filePath).toBe('out.ts')
  })
})

describe('classifyExecMessage', () => {
  it('classifies readArgs as redirectable', () => {
    const result = classifyExecMessage('readArgs')
    expect(result).toBe('redirect')
  })

  it('classifies shellArgs as redirectable', () => {
    expect(classifyExecMessage('shellArgs')).toBe('redirect')
  })

  it('classifies mcpArgs as passthrough', () => {
    expect(classifyExecMessage('mcpArgs')).toBe('passthrough')
  })

  it('classifies requestContextArgs as internal', () => {
    expect(classifyExecMessage('requestContextArgs')).toBe('internal')
  })

  it('classifies diagnosticsArgs as reject', () => {
    expect(classifyExecMessage('diagnosticsArgs')).toBe('reject')
  })

  it('classifies unknown exec types as reject', () => {
    expect(classifyExecMessage('unknownArgs')).toBe('reject')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/proxy/native-tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement native-tools.ts**

Port from the Hardcode84 fork (~754 lines). This is the largest single module. Key exports:

- `MCP_TOOL_PREFIX` — `"mcp_pi_"` prefix for MCP tool names
- `stripMcpToolPrefix(name)` — remove prefix from tool name
- `fixMcpArgNames(toolName, args)` — fix Cursor→Pi argument name mismatches (e.g., `path` → `filePath`)
- `classifyExecMessage(execCase)` — returns `"redirect"` | `"passthrough"` | `"internal"` | `"reject"`
- `redirectNativeTool(execMsg, sendFrame)` — translate native tool call to OpenAI tool_calls format, returns `PendingExec`
- `sendNativeResult(exec, content, isError, sendFrame)` — format tool result as native Cursor protobuf
- `sendMcpResultSuccess(exec, content, sendFrame)` — format tool result as MCP protobuf
- `rejectNativeTool(execMsg, sendFrame)` — send rejection response for unsupported tools
- `PendingExec` interface — tracks pending tool executions with native type info

Redirection mappings:
| Native exec | Pi tool | Result type |
|---|---|---|
| `readArgs` | `read` | `readResult` (native) |
| `writeArgs` | `write` | `writeResult` (native) |
| `deleteArgs` | `bash` (rm) | `deleteResult` (native) |
| `shellArgs` / `shellStreamArgs` | `bash` | `shellResult` (native) |
| `lsArgs` | `glob` | `lsResult` (MCP fallback) |
| `grepArgs` | `grep` | `grepResult` (native) |
| `fetchArgs` | `bash` (curl) | `fetchResult` (native) |
| `mcpArgs` | passthrough | `mcpResult` |

Rejected (no Pi equivalent): `diagnosticsArgs`, `backgroundShellSpawnArgs`, `writeShellStdinArgs`, `computerUseArgs`, `recordScreenArgs`, `listMcpResourcesExecArgs`, `readMcpResourceExecArgs`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy/native-tools.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy/native-tools.ts src/proxy/native-tools.test.ts
git commit -m "feat: native tool redirection and rejection"
```

---

## Task 9: PKCE and OAuth auth

**Phase: 2 (parallel with Tasks 2–8)**

**Files:**

- Create: `src/pkce.ts`
- Create: `src/auth.ts`

- [ ] **Step 1: Implement pkce.ts**

```typescript
// src/pkce.ts
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  const verifier = Buffer.from(array).toString('base64url').replace(/=+$/, '')

  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const challenge = Buffer.from(new Uint8Array(hash)).toString('base64url').replace(/=+$/, '')

  return { verifier, challenge }
}
```

- [ ] **Step 2: Implement auth.ts**

Port from the Hardcode84 fork / original repo (~141 lines). Key exports:

- `generateCursorAuthParams()` — generate PKCE verifier/challenge, UUID, login URL
- `pollCursorAuth(uuid, verifier)` — poll `api2.cursor.sh/auth/poll` with backoff until user completes login
- `refreshCursorToken(refreshToken)` — exchange refresh token for new access token
- `getTokenExpiry(token)` — extract JWT expiry with 5-minute safety margin

See Task 16's original code (now at the end of this plan as reference) for the full implementation.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/pkce.ts src/auth.ts
git commit -m "feat: Cursor PKCE OAuth (login, poll, token refresh)"
```

---

## Task 10: Cursor message processing

**Phase: 3 (depends on Tasks 2, 7, 8)**

**Files:**

- Create: `src/proxy/cursor-messages.ts`

- [ ] **Step 1: Implement cursor-messages.ts**

Port from the Hardcode84 fork (~530 lines). This module processes Cursor's `AgentServerMessage` protobuf messages and dispatches them:

- `processServerMessage(msg, ctx)` — main dispatcher. Routes by `msg.message.case`:
  - `interactionUpdate` → extract text/thinking deltas, token counts, tool call notifications
  - `kvServerMessage` → handle blob get/set (respond inline)
  - `execServerMessage` → dispatch to native-tools (redirect, passthrough, reject, or requestContext)
  - `conversationCheckpointUpdate` → extract checkpoint, emit to callback
  - `interactionQuery` → auto-approve search/question queries
  - `endStream` → signal done

- `StreamState` interface — tracks output tokens, total tokens, batch state signals

This module depends on: `native-tools.ts`, `request-context.ts`, `connect-protocol.ts`, proto types.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors (or only import path issues to fix)

- [ ] **Step 3: Commit**

```bash
git add src/proxy/cursor-messages.ts
git commit -m "feat: Cursor protobuf message processing and dispatch"
```

---

## Task 11: CursorSession — H2 connection + batch state machine

**Phase: 3 (depends on Tasks 2, 3, 10)**

**Files:**

- Create: `src/proxy/cursor-session.ts`

- [ ] **Step 1: Implement cursor-session.ts**

Port from the Hardcode84 fork (~521 lines). This is the core session class:

```typescript
export type SessionEvent =
  | { type: 'text'; text: string; isThinking: boolean }
  | { type: 'toolCall'; exec: PendingExec }
  | { type: 'batchReady' }
  | { type: 'usage'; outputTokens: number; totalTokens: number }
  | { type: 'done'; error?: string; retryHint?: RetryHint }
```

**CursorSession class:**

- Constructor: opens H2 connection to `api2.cursor.sh`, sends `AgentRunRequest` frame, starts heartbeat timer
- Batch state machine: `STREAMING → COLLECTING → FLUSHED`
  - `STREAMING`: text deltas flow, no pending tool calls
  - `COLLECTING`: `mcpArgs` arrived, accumulating tool calls
  - `FLUSHED`: boundary signal received (checkpoint/stepCompleted/turnEnded), emit `batchReady`
- `next(): Promise<SessionEvent>` — consume from event queue
- `sendToolResults(results)` — send `mcpResult` frames for each pending exec, reset to STREAMING
- `close()` — clean up H2 session, timers
- Inactivity timer: 30s thinking, 15s streaming, 10min flushed
- Auto-resume: on timeout or blob-not-found, restart from checkpoint (up to 5 attempts)

Uses `node:http2` directly (no child process). Connect protocol headers:

```typescript
const headers = {
  ':method': 'POST',
  ':path': '/agent.v1.AgentService/Run',
  'content-type': 'application/connect+proto',
  'connect-protocol-version': '1',
  te: 'trailers',
  authorization: `Bearer ${accessToken}`,
  'x-ghost-mode': 'true',
  'x-cursor-client-version': 'cli-2026.01.09-231024f',
  'x-cursor-client-type': 'cli',
  'x-request-id': randomUUID(),
}
```

Also export `callCursorUnaryRpc()` for model discovery (unary `application/proto` requests).

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/cursor-session.ts
git commit -m "feat: CursorSession with H2 connection, batch state machine, auto-resume"
```

---

## Task 12: OpenAI SSE stream writer

**Phase: 3 (depends on Tasks 4, 11)**

**Files:**

- Create: `src/proxy/openai-stream.ts`

- [ ] **Step 1: Implement openai-stream.ts**

Port from the Hardcode84 fork (~315 lines). This module consumes `SessionEvent` from `CursorSession` and produces OpenAI-format SSE chunks:

- `createSSECtx(controller, modelId, completionId, created)` — wraps a `ReadableStreamDefaultController` with SSE helpers:
  - `sendChunk(delta, finishReason)` — emit `chat.completion.chunk`
  - `sendUsage(usage)` — emit usage chunk
  - `sendDone()` — emit `data: [DONE]`
  - `close()` — close the stream
  - SSE keepalive every 15s (`: keep-alive\n\n`)

- `pumpSession(session, ctx)` — main loop:

  ```typescript
  async function pumpSession(session: CursorSession, ctx: SSECtx): Promise<PumpResult> {
    const tagFilter = createThinkingTagFilter()
    let toolCallIndex = 0
    for (;;) {
      const event = await session.next()
      switch (event.type) {
        case 'text':
          if (event.isThinking) {
            ctx.sendChunk({ reasoning_content: event.text })
          } else {
            const { content, reasoning } = tagFilter.process(event.text)
            if (reasoning) ctx.sendChunk({ reasoning_content: reasoning })
            if (content) ctx.sendChunk({ content })
          }
          break
        case 'toolCall':
          // flush any buffered thinking
          const flushed = tagFilter.flush()
          if (flushed.reasoning) ctx.sendChunk({ reasoning_content: flushed.reasoning })
          if (flushed.content) ctx.sendChunk({ content: flushed.content })
          ctx.sendChunk({
            tool_calls: [
              {
                index: toolCallIndex++,
                id: event.exec.toolCallId,
                type: 'function',
                function: { name: event.exec.toolName, arguments: event.exec.decodedArgs },
              },
            ],
          })
          break
        case 'batchReady':
          ctx.sendChunk({}, 'tool_calls')
          return 'batchReady'
        case 'usage':
          // accumulated, emitted at done
          break
        case 'done':
          const f = tagFilter.flush()
          if (f.reasoning) ctx.sendChunk({ reasoning_content: f.reasoning })
          if (f.content) ctx.sendChunk({ content: f.content })
          ctx.sendChunk({}, 'stop')
          return event.error ? 'error' : 'done'
      }
    }
  }
  ```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/openai-stream.ts
git commit -m "feat: OpenAI SSE stream writer consuming CursorSession events"
```

---

## Task 13: Session manager

**Phase: 3 (depends on Tasks 5, 11)**

**Files:**

- Create: `src/proxy/session-manager.ts`

- [ ] **Step 1: Implement session-manager.ts**

This module manages active `CursorSession` instances, keyed by session ID + conversation key:

```typescript
// src/proxy/session-manager.ts
import { createHash } from 'node:crypto'
import type { CursorSession } from './cursor-session.ts'
import type { OpenAIMessage } from './openai-messages.ts'
import { textContent } from './openai-messages.ts'

interface ActiveSession {
  session: CursorSession
  lastAccessMs: number
}

const activeSessions = new Map<string, ActiveSession>()
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function deriveSessionKey(sessionId: string, messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : ''
  return createHash('sha256')
    .update(`session:${sessionId}:${firstUserText.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16)
}

export function deriveConversationKey(sessionId: string, messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : ''
  return createHash('sha256')
    .update(`conv:${sessionId}:${firstUserText.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16)
}

export function getActiveSession(key: string): CursorSession | undefined {
  const entry = activeSessions.get(key)
  if (entry) {
    entry.lastAccessMs = Date.now()
    return entry.session
  }
  return undefined
}

export function setActiveSession(key: string, session: CursorSession): void {
  activeSessions.set(key, { session, lastAccessMs: Date.now() })
}

export function removeActiveSession(key: string): void {
  const entry = activeSessions.get(key)
  if (entry) {
    entry.session.close()
    activeSessions.delete(key)
  }
}

export function evictStaleSessions(): void {
  const now = Date.now()
  for (const [key, entry] of activeSessions) {
    if (now - entry.lastAccessMs > SESSION_TTL_MS) {
      entry.session.close()
      activeSessions.delete(key)
    }
  }
}

export function closeAllSessions(): void {
  for (const [key, entry] of activeSessions) {
    entry.session.close()
  }
  activeSessions.clear()
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/session-manager.ts
git commit -m "feat: session manager with TTL eviction and session isolation"
```

---

## Task 14: Model discovery

**Phase: 3 (depends on Task 11)**

**Files:**

- Create: `src/proxy/models.ts`

- [ ] **Step 1: Implement models.ts**

Port from the Hardcode84 fork (~492 lines). Two discovery strategies:

1. **Primary: `AvailableModels` RPC** (via `aiserver.v1.AiService`) — returns detailed model info including `supports_thinking`, `supports_images`, `context_token_limit`, `client_display_name`
2. **Fallback: `GetUsableModels` RPC** (via `agent.v1.AgentService`) — returns basic model IDs

```typescript
export interface CursorModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
}

export async function discoverCursorModels(accessToken: string): Promise<CursorModel[]> {
  // Try AvailableModels first (richer data)
  const primary = await fetchAvailableModels(accessToken)
  if (primary && primary.length > 0) return primary

  // Fallback to GetUsableModels
  const fallback = await fetchUsableModels(accessToken)
  if (fallback && fallback.length > 0) return fallback

  return [] // No models available — auth may be wrong
}
```

Model filtering: exclude `is_hidden`, `is_chat_only`, models that don't `supports_agent`. Sort alphabetically by ID.

Uses `callCursorUnaryRpc()` from `cursor-session.ts` for both RPCs.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/models.ts
git commit -m "feat: model discovery via AvailableModels + GetUsableModels gRPC"
```

---

## Task 15: Internal API endpoints

**Phase: 4 (depends on Task 14)**

**Files:**

- Create: `src/proxy/internal-api.ts`

- [ ] **Step 1: Implement internal-api.ts**

```typescript
// src/proxy/internal-api.ts
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
}) {
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
    for (const [id, session] of activeSessions) {
      if (now - session.lastHeartbeatMs > HEARTBEAT_TIMEOUT_MS) {
        activeSessions.delete(id)
      }
    }
    if (activeSessions.size === 0) {
      console.error('[proxy] No active sessions, shutting down')
      shutdownCallback?.()
    }
  }, 10_000)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return timer
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
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
    const body = JSON.parse(await readBody(req))
    const sessionId = body.sessionId
    if (!sessionId) {
      jsonResponse(res, 400, { error: 'sessionId required' })
      return
    }
    activeSessions.set(sessionId, { sessionId, lastHeartbeatMs: Date.now() })
    jsonResponse(res, 200, { ok: true })
    return
  }

  if (path === '/internal/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req))
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
    } catch (err) {
      jsonResponse(res, 500, { error: String(err) })
    }
    return
  }

  jsonResponse(res, 404, { error: 'not found' })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/internal-api.ts
git commit -m "feat: internal API (heartbeat, token, health, model refresh)"
```

---

## Task 16: Proxy HTTP server (main entry point)

**Phase: 4 (depends on Tasks 10–15)**

**Files:**

- Create: `src/proxy/main.ts`

- [ ] **Step 1: Implement main.ts**

This is the proxy entry point. It:

1. Reads config from stdin (first JSON line: `{ accessToken, conversationDir }`)
2. Discovers models via gRPC
3. Starts HTTP server on port 0
4. Writes `{"type":"ready","port":N,"models":[...]}` to stdout
5. Routes requests:
   - `POST /v1/chat/completions` → chat completion handler
   - `GET /v1/models` → model list
   - `/internal/*` → internal API
6. Handles chat completions:
   - Parse OpenAI request body
   - Read `X-Session-Id` header
   - Look up or create `CursorSession`
   - If tool results present and active session exists → `sendToolResults()` and resume
   - Otherwise → create new session with `AgentRunRequest`
   - Pump session events through SSE writer
   - On `batchReady` → keep session alive for tool result continuation
   - On `done` → clean up session

```typescript
// src/proxy/main.ts — structure outline
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
// ... imports for all proxy modules

async function main() {
  // 1. Read config from stdin
  const rl = createInterface({ input: process.stdin })
  const configLine = await new Promise<string>((resolve) => {
    rl.once('line', resolve)
  })
  rl.close()
  const config = JSON.parse(configLine)

  // 2. Configure internal API
  configureInternalApi({
    initialToken: config.accessToken,
    initialModels: [],
    onShutdown: () => process.exit(0),
  })

  // 3. Discover models
  let models: CursorModel[] = []
  try {
    models = await discoverCursorModels(config.accessToken)
  } catch (err) {
    console.error('[proxy] Model discovery failed:', err)
  }

  // 4. Start HTTP server
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (url.pathname.startsWith('/internal/')) {
      await handleInternalRequest(req, res, url.pathname)
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // Return model list
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      // Handle chat completion — main logic
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  })

  server.listen(0, () => {
    const port = (server.address() as any).port
    // 5. Write ready signal to stdout
    console.log(JSON.stringify({ type: 'ready', port, models }))

    // 6. Start heartbeat monitor
    startHeartbeatMonitor()
  })
}

main().catch((err) => {
  console.error('[proxy] Fatal:', err)
  process.exit(1)
})
```

The chat completion handler is the most complex part (~200 lines). It:

- Parses the request body as `ChatCompletionRequest`
- Reads `X-Session-Id` header (defaults to `"default"`)
- Derives session key and conversation key
- Converts OpenAI tool defs → Cursor MCP tool definitions
- Builds `AgentRunRequest` protobuf from conversation state
- Creates or resumes a `CursorSession`
- Returns a `ReadableStream` SSE response via `pumpSession()`

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test manually (if Cursor subscription available)**

```bash
# Terminal 1: Start proxy
echo '{"accessToken":"YOUR_TOKEN"}' | node --experimental-strip-types src/proxy/main.ts

# Terminal 2: Send a test request
curl -X POST http://localhost:<PORT>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2","messages":[{"role":"user","content":"Say hello"}],"stream":true}'
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy/main.ts
git commit -m "feat: proxy HTTP server with chat completion routing"
```

---

## Task 17: Proxy lifecycle management

**Phase: 4 (depends on Task 14)**

**Files:**

- Create: `src/proxy-lifecycle.ts`

- [ ] **Step 1: Implement proxy-lifecycle.ts**

This module manages the proxy process from the extension side:

```typescript
// src/proxy-lifecycle.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { CursorModel } from './proxy/models.ts'

const PORT_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')
const PROXY_ENTRY = resolve(import.meta.dirname, 'proxy', 'main.ts')
const HEARTBEAT_INTERVAL_MS = 10_000

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

let activeConnection: ProxyConnection | null = null

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = check existence
    return true
  } catch {
    return false
  }
}

export function readPortFile(): ProxyInfo | null {
  try {
    if (!existsSync(PORT_FILE)) return null
    const data = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
    if (data.port && data.pid && isProcessAlive(data.pid)) return data
    // Stale port file — clean up
    try {
      unlinkSync(PORT_FILE)
    } catch {}
    return null
  } catch {
    return null
  }
}

function writePortFile(info: ProxyInfo): void {
  const dir = join(homedir(), '.pi', 'agent')
  const { mkdirSync } = require('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(PORT_FILE, JSON.stringify(info))
}

async function checkProxyHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/internal/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function sendHeartbeat(port: number, sessionId: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/internal/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {}
}

async function pushToken(port: number, accessToken: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/internal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: accessToken }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {}
}

export async function refreshModels(port: number): Promise<CursorModel[]> {
  const res = await fetch(`http://localhost:${port}/internal/refresh-models`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  })
  const data = (await res.json()) as { models: CursorModel[] }
  return data.models
}

export async function connectToProxy(
  sessionId: string,
  accessToken: string | null,
): Promise<{ port: number; models: CursorModel[] }> {
  // 1. Try existing proxy via port file
  const existing = readPortFile()
  if (existing && (await checkProxyHealth(existing.port))) {
    if (accessToken) await pushToken(existing.port, accessToken)
    startHeartbeat(existing.port, existing.pid, sessionId)
    const models = await refreshModels(existing.port)
    return { port: existing.port, models }
  }

  // 2. Spawn new proxy
  if (!accessToken) throw new Error('No access token and no existing proxy')
  return spawnProxy(sessionId, accessToken)
}

async function spawnProxy(sessionId: string, accessToken: string): Promise<{ port: number; models: CursorModel[] }> {
  const child = spawn('node', ['--experimental-strip-types', PROXY_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })

  // Send config on stdin
  child.stdin!.write(JSON.stringify({ accessToken }) + '\n')
  child.stdin!.end()

  // Read ready signal from stdout
  const rl = createInterface({ input: child.stdout! })
  const readyLine = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Proxy startup timeout')), 15000)
    rl.once('line', (line) => {
      clearTimeout(timeout)
      resolve(line)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Proxy exited with code ${code}`))
    })
  })
  rl.close()

  const ready = JSON.parse(readyLine)
  if (ready.type !== 'ready' || !ready.port) {
    throw new Error(`Unexpected proxy output: ${readyLine}`)
  }

  // Write port file
  writePortFile({ port: ready.port, pid: child.pid! })

  // Start heartbeat
  startHeartbeat(ready.port, child.pid!, sessionId)

  // Log proxy stderr
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[cursor-proxy] ${chunk.toString().trimEnd()}`)
  })

  // Don't let the child keep the parent alive
  child.unref()

  return { port: ready.port, models: ready.models ?? [] }
}

function startHeartbeat(port: number, pid: number, sessionId: string): void {
  stopHeartbeat()
  sendHeartbeat(port, sessionId) // immediate first heartbeat
  const timer = setInterval(() => sendHeartbeat(port, sessionId), HEARTBEAT_INTERVAL_MS)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  activeConnection = { port, pid, heartbeatTimer: timer, sessionId }
}

export function stopHeartbeat(): void {
  if (activeConnection) {
    clearInterval(activeConnection.heartbeatTimer)
    activeConnection = null
  }
}

export function getActivePort(): number | null {
  return activeConnection?.port ?? null
}

export function getActivePid(): number | null {
  return activeConnection?.pid ?? null
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy-lifecycle.ts
git commit -m "feat: proxy lifecycle (spawn, discover, reconnect, heartbeat)"
```

---

## Task 18: Extension entry point

**Phase: 4 (depends on Tasks 9, 17)**

**Files:**

- Create: `src/index.ts`

- [ ] **Step 1: Implement index.ts**

```typescript
// src/index.ts
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken } from './auth.ts'
import {
  connectToProxy,
  stopHeartbeat,
  getActivePort,
  getActivePid,
  readPortFile,
  refreshModels,
} from './proxy-lifecycle.ts'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CursorModel } from './proxy/models.ts'

const PROVIDER_ID = 'cursor'
const MODEL_CACHE_PATH = join(homedir(), '.pi', 'agent', 'cursor-model-cache.json')

function loadModelCache(): CursorModel[] {
  try {
    if (!existsSync(MODEL_CACHE_PATH)) return []
    return JSON.parse(readFileSync(MODEL_CACHE_PATH, 'utf8'))
  } catch {
    return []
  }
}

function saveModelCache(models: CursorModel[]): void {
  try {
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true })
    writeFileSync(MODEL_CACHE_PATH, JSON.stringify(models))
  } catch {}
}

function cursorModelsToProviderModels(models: CursorModel[], port: number) {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: (m.supportsImages ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }))
}

export default async function (pi: ExtensionAPI) {
  const sessionId = crypto.randomUUID()
  let currentPort: number | null = null

  // --- OAuth ---
  async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { verifier, uuid, loginUrl } = await generateCursorAuthParams()
    callbacks.onAuth({ url: loginUrl })
    const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier)
    return {
      refresh: refreshToken,
      access: accessToken,
      expires: getTokenExpiry(accessToken),
    }
  }

  async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const result = await refreshCursorToken(credentials.refresh)
    // Push new token to proxy if running
    const port = getActivePort()
    if (port) {
      try {
        await fetch(`http://localhost:${port}/internal/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access: result.access }),
          signal: AbortSignal.timeout(2000),
        })
      } catch {}
    }
    return result
  }

  // --- Try to connect to existing proxy or spawn new one ---
  // Use cached models for fast startup, refresh in background
  const cachedModels = loadModelCache()

  // On startup, try to connect to an existing proxy (no token needed — just health check).
  // If no proxy exists, we wait until /login provides credentials.
  let models: CursorModel[] = loadModelCache()
  let accessToken: string | null = null

  const existing = readPortFile()
  if (existing) {
    try {
      const result = await connectToProxy(sessionId, null)
      currentPort = result.port
      if (result.models.length > 0) {
        models = result.models
        saveModelCache(models)
      }
    } catch {
      // No existing proxy — wait for /login
    }
  }

  // --- Register provider ---
  // modifyModels is called by Pi after login/refresh with fresh credentials.
  // We use it to push the token to the proxy and spawn it if needed.
  const oauthConfig = {
    name: 'Cursor',
    login: loginCursor,
    refreshToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    async modifyModels(registeredModels: any[], credentials: OAuthCredentials) {
      accessToken = credentials.access
      try {
        const result = await connectToProxy(sessionId, credentials.access)
        currentPort = result.port
        if (result.models.length > 0) {
          models = result.models
          saveModelCache(models)
          // Re-register with discovered models
          pi.registerProvider(PROVIDER_ID, {
            name: 'Cursor',
            baseUrl: `http://localhost:${currentPort}/v1`,
            apiKey: 'cursor-proxy',
            api: 'openai-completions',
            models: cursorModelsToProviderModels(models, currentPort),
            oauth: oauthConfig,
          })
        }
      } catch (err) {
        console.error(`[pi-cursor] Failed to connect to proxy: ${err}`)
      }
      return registeredModels
    },
  }

  pi.registerProvider(PROVIDER_ID, {
    name: 'Cursor',
    baseUrl: currentPort ? `http://localhost:${currentPort}/v1` : 'http://localhost:0/v1',
    apiKey: 'cursor-proxy',
    api: 'openai-completions',
    models: currentPort ? cursorModelsToProviderModels(models, currentPort) : [],
    oauth: oauthConfig,
  })

  // --- Add X-Session-Id header to all requests ---
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider === PROVIDER_ID && event.payload) {
      // Pi's openai-completions handler passes headers through
      // We rely on the proxy reading X-Session-Id from the request
    }
  })

  // --- Lifecycle events ---
  pi.on('session_start', async (event, ctx) => {
    if (event.reason === 'reload') {
      // Reconnect to existing proxy
      const port = getActivePort()
      if (!port && accessToken) {
        try {
          const result = await connectToProxy(sessionId, accessToken)
          currentPort = result.port
        } catch {}
      }
    }

    // Restore proxy info from session state
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'cursor-proxy') {
        const { port, pid } = entry.data as { port: number; pid: number }
        try {
          const result = await connectToProxy(sessionId, accessToken)
          currentPort = result.port
          if (result.models.length > 0) {
            models = result.models
            saveModelCache(models)
            pi.registerProvider(PROVIDER_ID, {
              name: 'Cursor',
              baseUrl: `http://localhost:${currentPort}/v1`,
              apiKey: 'cursor-proxy',
              api: 'openai-completions',
              models: cursorModelsToProviderModels(models, currentPort),
              oauth: {
                name: 'Cursor',
                login: loginCursor,
                refreshToken,
                getApiKey: (cred) => cred.access,
              },
            })
          }
        } catch {}
        break
      }
    }
  })

  pi.on('session_shutdown', async (event, ctx) => {
    // Persist proxy info for reconnect
    const port = getActivePort()
    const pid = getActivePid()
    if (port && pid) {
      pi.appendEntry('cursor-proxy', { port, pid })
    }
    stopHeartbeat()
  })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: Pi extension entry point with OAuth, provider registration, lifecycle"
```

---

## Task 19: Integration testing with live Cursor subscription

**Phase: 5 (depends on all previous tasks)**

**Files:** No new files — manual testing

- [ ] **Step 1: Install the extension**

Symlink the project into Pi's global extensions directory:

```bash
# Windows
mklink /D "%USERPROFILE%\.pi\agent\extensions\pi-cursor" "C:\Users\pschu\Projects\pi\pi-cursor"

# macOS/Linux
ln -s ~/Projects/pi/pi-cursor ~/.pi/agent/extensions/pi-cursor
```

- [ ] **Step 2: Start Pi and authenticate**

```bash
pi
```

Run: `/login cursor`
Expected: Browser opens to Cursor login page. After authentication, Pi shows "Login successful."

- [ ] **Step 3: Verify models appear**

Run: `/model`
Expected: Cursor models appear in the model list (e.g., `cursor/composer-2`, `cursor/claude-4.6-sonnet`)

- [ ] **Step 4: Test basic conversation**

Select a Cursor model and send a simple prompt:

```
Say hello and tell me what model you are.
```

Expected: Model responds with text streamed via SSE.

- [ ] **Step 5: Test tool usage**

```
Read the file package.json and tell me what dependencies it has.
```

Expected: Model calls `read` tool (via native redirection or MCP), Pi executes it, result flows back, model summarizes the file.

- [ ] **Step 6: Test thinking/reasoning**

Select a reasoning-capable model (e.g., `composer-2`) and send:

```
Think step by step about what 127 * 33 equals.
```

Expected: Thinking content appears as reasoning, followed by the answer.

- [ ] **Step 7: Test /reload survival**

While connected:

```
/reload
```

Then send another prompt.
Expected: Proxy survives reload. New extension instance reconnects. Conversation continues.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes"
```

---

## Verification Checklist

- [ ] `npx vitest run` — all unit tests pass (connect-protocol, event-queue, thinking-filter, openai-messages, native-tools, conversation-state)
- [ ] `/login cursor` — OAuth flow completes, credentials persisted
- [ ] `/model` — Cursor models listed dynamically (no hard-coded models)
- [ ] Simple prompt — text streams correctly
- [ ] Tool call — native redirection works (read, write, bash)
- [ ] Thinking — reasoning content surfaces in Pi
- [ ] `/reload` — proxy survives, extension reconnects
- [ ] Second Pi session — discovers existing proxy via port file, shares it
- [ ] System prompt — delivered via cloud rule, model follows instructions
- [ ] Long session — checkpoint persistence prevents "blob not found"
