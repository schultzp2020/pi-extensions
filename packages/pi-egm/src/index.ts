import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import lockfile from 'proper-lockfile'

import { type GitBackend, EGM_PACKAGE_SPEC, egmAgentsDir, egmCheckoutDir, latestReleaseTag } from './egm.ts'
import { createIsomorphicGitBackend } from './git.ts'
import {
  ensureAgentScanDir,
  egmPinnedRefFromSettings,
  type Settings,
  isRecord,
  pinEgmPackageRef,
  removeAgentScanDir,
} from './settings.ts'

/** Acquire pi's settings lock (proper-lockfile, lockSync with ELOCKED retry) and release in finally. */
function acquireSettingsLock(path: string): (() => void) | undefined {
  const maxAttempts = 10
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
      if (code !== 'ELOCKED' || attempt === maxAttempts) {
        return undefined
      }
      // chisle: sync backoff, mirrors pi's FileSettingsStorage
      const start = Date.now()
      while (Date.now() - start < 20) {
        // busy-wait
      }
    }
  }
  return undefined
}

/**
 * Run fn while holding pi's lock on the settings file, so a concurrent pi process
 * cannot interleave a write between our read and write. Mirrors FileSettingsStorage.withLock.
 */
function withSettingsLock<T>(path: string, fn: () => T): T {
  let release: (() => void) | undefined
  try {
    if (existsSync(path)) {
      release = acquireSettingsLock(path)
    }
    return fn()
  } finally {
    release?.()
  }
}

export interface EgmExtensionOptions {
  agentDir?: string
  backend?: GitBackend
  exists?: (path: string) => boolean
}

/**
 * Register (or, when the EGM checkout is gone, remove) the personas scan dir in
 * settings.json. The whole read-merge-write runs under pi's settings lock and
 * fails closed on unreadable or unsupported shapes. Idempotent.
 */
export function wirePersonas(agentDir: string, exists: (p: string) => boolean): boolean {
  const settingsPath = join(agentDir, 'settings.json')
  if (!exists(settingsPath)) {
    return false
  }
  const agentsDir = egmAgentsDir(agentDir)
  return withSettingsLock(settingsPath, () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return false
    }
    if (!isRecord(parsed)) {
      return false
    }
    const settings = parsed as Settings
    const result = exists(agentsDir) ? ensureAgentScanDir(settings, agentsDir) : removeAgentScanDir(settings, agentsDir)
    if (!result.changed) {
      return false
    }
    try {
      writeFileSync(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  })
}

/** Read and validate settings.json; throws with a user-facing message when unusable. */
function readSettingsStrict(agentDir: string): Settings {
  const settingsPath = join(agentDir, 'settings.json')
  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    throw new Error(`cannot read ${settingsPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${settingsPath} is not valid JSON`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object`)
  }
  return parsed
}

export function registerEgmCommands(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: EgmExtensionOptions = {},
): void {
  const agentDir = options.agentDir ?? getAgentDir()
  const backend = options.backend ?? createIsomorphicGitBackend()
  const exists = options.exists ?? existsSync
  const checkout = egmCheckoutDir(agentDir)

  const requireCheckout = (ctx: ExtensionCommandContext): boolean => {
    if (exists(checkout)) {
      return true
    }
    ctx.ui.notify(
      `EGM checkout not found at ${checkout}.\nInstall the package first: pi install ${EGM_PACKAGE_SPEC}`,
      'error',
    )
    return false
  }

  pi.registerCommand('egm-status', {
    description: 'Show the installed Elephant-Goldfish Model version and the latest release',
    handler: async (_args, ctx) => {
      if (!requireCheckout(ctx)) {
        return
      }
      const current = await backend.headDescription(checkout)
      let pinned: string | undefined
      try {
        pinned = egmPinnedRefFromSettings(readSettingsStrict(agentDir))
      } catch {
        pinned = undefined
      }
      let latest = 'unknown'
      try {
        latest = (await backend.listRemoteTags().then(latestReleaseTag)) ?? 'none'
      } catch {
        // offline: leave unknown
      }
      const pin = pinned ? `pinned to ${pinned}` : 'tracking default branch'
      ctx.ui.notify(`EGM: ${current} (${pin}); latest release: ${latest}`, 'info')
    },
  })

  pi.registerCommand('egm-update', {
    description:
      'Update EGM to the latest release (or a given tag/branch, e.g. /egm-update main); --force discards local checkout edits',
    handler: async (args, ctx) => {
      if (!requireCheckout(ctx)) {
        return
      }
      const tokens = args.split(/\s+/).filter(Boolean)
      const unknownFlags = tokens.filter((t) => t.startsWith('--') && t !== '--force')
      if (unknownFlags.length > 0) {
        ctx.ui.notify(`Unknown option: ${unknownFlags.join(', ')}`, 'error')
        return
      }
      const force = tokens.includes('--force')
      const requested = tokens.find((t) => !t.startsWith('--')) ?? ''

      // Fail closed on unusable settings before touching the checkout.
      try {
        readSettingsStrict(agentDir)
      } catch (error) {
        ctx.ui.notify(`Refusing to update: ${String(error instanceof Error ? error.message : error)}`, 'error')
        return
      }

      let ref: string | undefined = requested
      if (!ref) {
        try {
          ref = (await backend.listRemoteTags().then(latestReleaseTag)) ?? undefined
        } catch (error) {
          ctx.ui.notify(`Could not look up the latest release: ${String(error)}`, 'error')
          return
        }
        if (!ref) {
          ctx.ui.notify('No release tags exist upstream; pass a ref explicitly, e.g. /egm-update main', 'error')
          return
        }
      }

      // Git first, pin second: a failed fetch/checkout leaves settings untouched.
      let description: string
      try {
        description = await backend.update(checkout, ref, { force })
      } catch (error) {
        ctx.ui.notify(`Update failed; settings unchanged: ${String(error)}`, 'error')
        return
      }

      // Pin under pi's lock, re-reading so a concurrent pi write is not clobbered.
      const settingsPath = join(agentDir, 'settings.json')
      const pinned = withSettingsLock(settingsPath, () => {
        try {
          const settings = readSettingsStrict(agentDir)
          const result = pinEgmPackageRef(settings, ref === 'main' || ref === 'master' ? undefined : ref)
          if (result.changed) {
            writeFileSync(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`)
          }
          return true
        } catch {
          return false
        }
      })
      if (!pinned) {
        ctx.ui.notify(
          `Checkout moved to ${description} but the settings.json pin could not be persisted; ` +
            'pi reconciliation may revert it. Fix settings.json and re-run.',
          'error',
        )
        return
      }
      ctx.ui.notify(`EGM updated to ${ref} (${description}). Restart pi to reload skills and personas.`, 'info')
    },
  })
}

export default function (pi: ExtensionAPI): void {
  wirePersonas(getAgentDir(), existsSync)
  registerEgmCommands(pi)
}
