#!/usr/bin/env npx tsx
import * as http2 from 'node:http2'

/**
 * Capture what Cursor returns when we request models with `useModelParameters: true`.
 *
 * Usage:
 *   1. Get your access token from the running proxy:
 *      curl http://localhost:<proxy-port>/internal/token
 *
 *   2. Or extract from Pi's credential store — the proxy logs it on startup.
 *
 *   3. Run:
 *      CURSOR_TOKEN="your-token" npx tsx scripts/capture-model-parameters.ts
 *
 *   The script will call AvailableModels twice:
 *     - Without useModelParameters (current behavior)
 *     - With useModelParameters=true (new behavior)
 *   And dump both raw responses as JSON for comparison.
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'

import { AvailableModelsRequestSchema, AvailableModelsResponseSchema } from '../src/proto/aiserver_pb.ts'
import { decodeConnectUnaryBody } from '../src/proxy/connect-protocol.ts'

const CURSOR_API_URL = 'https://api2.cursor.sh'
const RPC_PATH = '/aiserver.v1.AiService/AvailableModels'

const token = process.env.CURSOR_TOKEN
if (!token) {
  console.error('Set CURSOR_TOKEN env var. Get it from your proxy: curl http://localhost:<port>/internal/token')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

function callRpc(requestBytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(CURSOR_API_URL)
    session.on('error', reject)

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': RPC_PATH,
      'content-type': 'application/proto',
      authorization: `Bearer ${token}`,
      'user-agent': 'connect-es/2.0.0-beta.2',
      'connect-protocol-version': '1',
    }

    const stream = session.request(headers)
    const chunks: Buffer[] = []

    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      session.close()
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', reject)

    stream.end(Buffer.from(requestBytes))
  })
}

function decodeResponse(payload: Uint8Array) {
  try {
    return fromBinary(AvailableModelsResponseSchema, payload)
  } catch {
    const framedBody = decodeConnectUnaryBody(payload)
    if (framedBody) {
      try {
        return fromBinary(AvailableModelsResponseSchema, framedBody)
      } catch {
        /* fall through */
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Fetching WITHOUT useModelParameters ===\n')

  const reqOld = create(AvailableModelsRequestSchema, {
    includeLongContextModels: true,
    includeHiddenModels: true,
  })
  const respOldBytes = await callRpc(toBinary(AvailableModelsRequestSchema, reqOld))
  const respOld = decodeResponse(respOldBytes)

  if (respOld) {
    console.log(`Models count: ${respOld.models.length}`)
    console.log(`useModelParameters (response): ${respOld.useModelParameters}`)
    console.log(`modelNames count: ${respOld.modelNames.length}`)
    console.log('\nFirst 5 models (old):')
    for (const m of respOld.models.slice(0, 5)) {
      console.log(
        JSON.stringify(
          {
            name: m.name,
            clientDisplayName: m.clientDisplayName,
            supportsMaxMode: m.supportsMaxMode,
            supportsThinking: m.supportsThinking,
            supportsImages: m.supportsImages,
            contextTokenLimit: m.contextTokenLimit,
            serverModelName: m.serverModelName,
            inputboxShortModelName: m.inputboxShortModelName,
            tagline: m.tagline,
            legacySlugs: m.legacySlugs,
            idAliases: m.idAliases,
          },
          null,
          2,
        ),
      )
    }
  } else {
    console.log('Failed to decode old response')
  }

  console.log('\n\n=== Fetching WITH useModelParameters=true ===\n')

  const reqNew = create(AvailableModelsRequestSchema, {
    includeLongContextModels: true,
    includeHiddenModels: true,
    useModelParameters: true,
  })
  const respNewBytes = await callRpc(toBinary(AvailableModelsRequestSchema, reqNew))
  const respNew = decodeResponse(respNewBytes)

  if (respNew) {
    console.log(`Models count: ${respNew.models.length}`)
    console.log(`useModelParameters (response): ${respNew.useModelParameters}`)
    console.log(`modelNames count: ${respNew.modelNames.length}`)
    console.log('\nAll models (new):')
    for (const m of respNew.models) {
      console.log(
        JSON.stringify(
          {
            name: m.name,
            clientDisplayName: m.clientDisplayName,
            supportsMaxMode: m.supportsMaxMode,
            supportsNonMaxMode: m.supportsNonMaxMode,
            supportsThinking: m.supportsThinking,
            supportsImages: m.supportsImages,
            contextTokenLimit: m.contextTokenLimit,
            contextTokenLimitForMaxMode: m.contextTokenLimitForMaxMode,
            serverModelName: m.serverModelName,
            inputboxShortModelName: m.inputboxShortModelName,
            tagline: m.tagline,
            legacySlugs: m.legacySlugs,
            idAliases: m.idAliases,
            defaultOn: m.defaultOn,
            supportsAgent: m.supportsAgent,
            supportsPlanMode: m.supportsPlanMode,
            supportsSandboxing: m.supportsSandboxing,
            supportsCmdK: m.supportsCmdK,
            onlySupportsCmdK: m.onlySupportsCmdK,
            isHidden: m.isHidden,
            isChatOnly: m.isChatOnly,
            isLongContextOnly: m.isLongContextOnly,
            isUserAdded: m.isUserAdded,
            isRecommendedForBackgroundComposer: m.isRecommendedForBackgroundComposer,
          },
          null,
          2,
        ),
      )
    }
  } else {
    console.log('Failed to decode new response')
  }

  console.log('\n\n=== Fetching WITH variantsWillBeShownInExplodedList=true ===\n')

  const reqExploded = create(AvailableModelsRequestSchema, {
    includeLongContextModels: true,
    includeHiddenModels: true,
    useModelParameters: true,
    variantsWillBeShownInExplodedList: true,
  })
  const respExplodedBytes = await callRpc(toBinary(AvailableModelsRequestSchema, reqExploded))
  const respExploded = decodeResponse(respExplodedBytes)

  if (respExploded) {
    console.log(`Models count: ${respExploded.models.length}`)
    console.log(`useModelParameters (response): ${respExploded.useModelParameters}`)
    const names = respExploded.models.map((m) => m.name)
    console.log('\nAll model names:')
    for (const n of names) {
      console.log(`  ${n}`)
    }
  } else {
    console.log('Failed to decode exploded response')
  }

  // Also dump the full raw responses as JSON files
  const { writeFileSync } = await import('node:fs')
  if (respOld) {
    writeFileSync(
      'capture-old.json',
      JSON.stringify(
        respOld.models.map((m) => ({ ...m, $typeName: undefined })),
        null,
        2,
      ),
    )
    console.log('\nWrote capture-old.json')
  }
  if (respNew) {
    writeFileSync(
      'capture-new.json',
      JSON.stringify(
        respNew.models.map((m) => ({ ...m, $typeName: undefined })),
        null,
        2,
      ),
    )
    console.log('Wrote capture-new.json')
  }
  if (respExploded) {
    writeFileSync(
      'capture-exploded.json',
      JSON.stringify(
        respExploded.models.map((m) => ({ ...m, $typeName: undefined })),
        null,
        2,
      ),
    )
    console.log('Wrote capture-exploded.json')
  }
}

main().catch(console.error)
