import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import {
  type GitRunner,
  EGM_PACKAGE_SPEC,
  checkoutDescription,
  egmAgentsDir,
  egmCheckoutDir,
  latestReleaseTag,
  pinnedRef,
  updateCheckout,
} from './egm.ts'
import { ensureAgentScanDir, type Settings, pinEgmPackageRef } from './settings.ts'

/** Mirrors pi-subagents' agent-dir resolution: PI_CODING_AGENT_DIR (with ~) or ~/.pi/agent. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const configured = env.PI_CODING_AGENT_DIR
  if (configured === '~') {
    return home
  }
  if (configured?.startsWith('~/') || configured?.startsWith('~\\')) {
    return join(home, configured.slice(2))
  }
  return configured ?? join(home, '.pi', 'agent')
}

const execFileAsync = promisify(execFile)
const defaultGit: GitRunner = async (args, opts) =>
  (await execFileAsync('git', args, { cwd: opts?.cwd, encoding: 'utf8' })).stdout.trim()

export interface EgmExtensionOptions {
  agentDir?: string
  git?: GitRunner
  exists?: (path: string) => boolean
}

/** Register the EGM personas dir with pi-subagents; idempotent, fails silently when unreadable. */
export function wirePersonas(agentDir: string, exists: (p: string) => boolean): boolean {
  const settingsPath = join(agentDir, 'settings.json')
  if (!exists(settingsPath)) {
    return false
  }
  let settings: Settings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings
  } catch {
    return false
  }
  const result = ensureAgentScanDir(settings, egmAgentsDir(agentDir))
  if (!result.changed) {
    return false
  }
  try {
    writeFileSync(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

function readSettings(agentDir: string): Settings | undefined {
  try {
    return JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as Settings
  } catch {
    return undefined
  }
}

function writeSettings(agentDir: string, settings: Settings): boolean {
  try {
    writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

function egmPinnedRef(agentDir: string): string | undefined {
  const packages = readSettings(agentDir)?.packages
  if (!Array.isArray(packages)) {
    return undefined
  }
  for (const entry of packages) {
    if (typeof entry === 'string' && (entry === EGM_PACKAGE_SPEC || entry.startsWith(`${EGM_PACKAGE_SPEC}@`))) {
      return pinnedRef(entry)
    }
  }
  return undefined
}

export function registerEgmCommands(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: EgmExtensionOptions = {},
): void {
  const agentDir = options.agentDir ?? resolveAgentDir()
  const git = options.git ?? defaultGit
  const exists = options.exists ?? existsSync
  const checkout = egmCheckoutDir(agentDir)

  const notifyMissing = (ctx: ExtensionCommandContext): void => {
    ctx.ui.notify(
      `EGM checkout not found at ${checkout}.\nInstall the package first: pi install ${EGM_PACKAGE_SPEC}`,
      'error',
    )
  }

  const requireCheckout = (ctx: ExtensionCommandContext): boolean => {
    if (exists(checkout)) {
      return true
    }
    notifyMissing(ctx)
    return false
  }

  pi.registerCommand('egm-status', {
    description: 'Show the installed Elephant-Goldfish Model version and the latest release',
    handler: async (_args, ctx) => {
      if (!requireCheckout(ctx)) {
        return
      }
      const current = await checkoutDescription(git, checkout)
      const pinned = egmPinnedRef(agentDir)
      let latest = 'unknown'
      try {
        latest = (await latestReleaseTag(git)) ?? 'none'
      } catch {
        // offline: leave unknown
      }
      const pin = pinned ? `pinned to ${pinned}` : 'tracking default branch'
      ctx.ui.notify(`EGM: ${current} (${pin}); latest release: ${latest}`, 'info')
    },
  })

  pi.registerCommand('egm-update', {
    description: 'Update EGM to the latest release (or a given tag/branch, e.g. /egm-update main)',
    handler: async (args, ctx) => {
      if (!requireCheckout(ctx)) {
        return
      }
      const requested = args.trim()
      let ref: string | undefined = requested
      if (!ref) {
        try {
          ref = await latestReleaseTag(git)
        } catch (error) {
          ctx.ui.notify(`Could not look up the latest release: ${String(error)}`, 'error')
          return
        }
        if (!ref) {
          ctx.ui.notify('No release tags exist upstream; pass a ref explicitly, e.g. /egm-update main', 'error')
          return
        }
      }
      const settings = readSettings(agentDir)
      if (settings) {
        // Branch names unpin (track default); tags and commits pin.
        const trackDefault = ref === 'main' || ref === 'master'
        const pinned = pinEgmPackageRef(settings, trackDefault ? undefined : ref)
        if (pinned.changed && !writeSettings(agentDir, pinned.settings)) {
          ctx.ui.notify('Could not update settings.json package pin; aborting.', 'error')
          return
        }
      }
      let description: string
      try {
        description = await updateCheckout(git, checkout, ref)
      } catch (error) {
        ctx.ui.notify(`git update failed: ${String(error)}`, 'error')
        return
      }
      ctx.ui.notify(`EGM updated to ${ref} (${description}). Restart pi to reload skills and personas.`, 'info')
    },
  })
}

export default function (pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir()
  wirePersonas(agentDir, existsSync)
  registerEgmCommands(pi)
}
