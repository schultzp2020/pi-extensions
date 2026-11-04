import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'

import { EGM_PACKAGE_SPEC, type GitBackend, type RemoteTag } from './egm.ts'
import { registerEgmCommands, wirePersonas } from './index.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempAgentDir(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-egm-'))
  tempDirs.push(dir)
  if (settings !== undefined) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
  }
  return dir
}

function readSettingsFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

interface UpdateCall {
  ref: string
  force: boolean | undefined
}

/** A recording GitBackend fake; behaviors overridable per test. */
function fakeBackend(behavior: Partial<GitBackend> = {}): GitBackend & { updateCalls: UpdateCall[] } {
  const updateCalls: UpdateCall[] = []
  return {
    updateCalls,
    listRemoteTags: behavior.listRemoteTags ?? (() => Promise.resolve([{ name: 'v0.2.0', oid: 'b' }] as RemoteTag[])),
    isDirty: behavior.isDirty ?? (() => Promise.resolve(false)),
    headDescription: behavior.headDescription ?? (() => Promise.resolve('v0.2.0')),
    update:
      behavior.update ??
      ((checkout: string, ref: string, options?: { force?: boolean }) => {
        updateCalls.push({ ref, force: options?.force })
        return Promise.resolve('v0.2.0')
      }),
  }
}

interface CommandHarness {
  invoke(name: 'egm-status' | 'egm-update', args?: string): Promise<{ level: string; message: string }[]>
}

/** Register commands against a fake pi with a recording ui. */
function harness(options: { agentDir: string; backend: GitBackend }): CommandHarness {
  const notifications: { level: string; message: string }[] = []
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  registerEgmCommands(
    {
      registerCommand: (name, command) => {
        commands.set(name, command.handler as (args: string, ctx: unknown) => Promise<void>)
      },
    },
    { agentDir: options.agentDir, backend: options.backend, exists: () => true },
  )
  const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ level, message }) } }
  return {
    invoke: async (name, args = '') => {
      notifications.length = 0
      await commands.get(name)?.(args, ctx)
      return notifications
    },
  }
}

describe('wirePersonas', () => {
  it('adds the agents scan dir to settings.json once and releases the lock', () => {
    const dir = tempAgentDir({ theme: 'dark' })
    const expected = join(dir, 'git', 'github.com', 'google', 'elephant-goldfish-model', 'agents')

    expect(wirePersonas(dir, () => true)).toBeTruthy()
    const first = readSettingsFile(join(dir, 'settings.json'))
    expect(first.subagents).toEqual({ agentScanDirs: [expected] })
    expect(first.theme).toBe('dark')
    expect(existsSync(join(dir, 'settings.json.lock'))).toBeFalsy() // lock released

    expect(wirePersonas(dir, () => true)).toBeFalsy()
    expect(readSettingsFile(join(dir, 'settings.json')).subagents).toEqual({ agentScanDirs: [expected] })
  })

  it('removes the scan dir when the EGM checkout is gone', () => {
    const agents = join('git', 'github.com', 'google', 'elephant-goldfish-model', 'agents')
    const dir = tempAgentDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ subagents: { agentScanDirs: [join(dir, agents)] } }))
    const exists = (p: string) => !p.includes(join('git', 'github.com'))
    expect(wirePersonas(dir, exists)).toBeTruthy()
    expect(readSettingsFile(join(dir, 'settings.json')).subagents).toEqual({ agentScanDirs: [] })
  })

  it('returns false when settings.json is missing, malformed, or a non-object', () => {
    expect(wirePersonas(tempAgentDir(), () => true)).toBeFalsy()
    const malformed = tempAgentDir()
    writeFileSync(join(malformed, 'settings.json'), 'not json')
    expect(wirePersonas(malformed, () => true)).toBeFalsy()
    const nulled = tempAgentDir()
    writeFileSync(join(nulled, 'settings.json'), 'null')
    expect(wirePersonas(nulled, () => true)).toBeFalsy()
    expect(wirePersonas(tempAgentDir({ subagents: 'legacy' }), () => true)).toBeFalsy()
  })

  it('refuses to write while another process holds the settings lock', () => {
    const dir = tempAgentDir({ theme: 'dark' })
    const settingsPath = join(dir, 'settings.json')
    const release = lockfile.lockSync(settingsPath, { realpath: false })
    try {
      expect(wirePersonas(dir, () => true)).toBeFalsy()
      expect(readSettingsFile(settingsPath)).toEqual({ theme: 'dark' }) // unchanged
    } finally {
      release()
    }
    expect(wirePersonas(dir, () => true)).toBeTruthy() // succeeds once the lock frees
  })
})

describe('/egm-update', () => {
  it('pins and updates to the latest release tag', async () => {
    const dir = tempAgentDir({ packages: [EGM_PACKAGE_SPEC] })
    const backend = fakeBackend()
    const h = harness({ agentDir: dir, backend })
    const notes = await h.invoke('egm-update')
    expect(notes.at(-1)?.level).toBe('info')
    expect(readSettingsFile(join(dir, 'settings.json')).packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.2.0`])
    expect(backend.updateCalls).toEqual([{ ref: 'v0.2.0', force: false }])
  })

  it('passes --force through to the backend', async () => {
    const dir = tempAgentDir({ packages: [EGM_PACKAGE_SPEC] })
    const backend = fakeBackend()
    const h = harness({ agentDir: dir, backend })
    await h.invoke('egm-update', 'v0.1.0 --force')
    expect(backend.updateCalls).toEqual([{ ref: 'v0.1.0', force: true }])
  })

  it('leaves settings untouched when the update fails', async () => {
    const dir = tempAgentDir({ packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] })
    const backend = fakeBackend({
      update: () => {
        throw new Error('network down')
      },
    })
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-update')
    expect(notes.at(-1)?.level).toBe('error')
    expect(notes.at(-1)?.message).toContain('settings unchanged')
    expect(readSettingsFile(join(dir, 'settings.json')).packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.1.0`])
  })

  it('aborts before git when settings are unreadable', async () => {
    const dir = tempAgentDir()
    writeFileSync(join(dir, 'settings.json'), 'not json')
    const backend = fakeBackend()
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-update', 'v0.2.0')
    expect(notes.at(-1)?.level).toBe('error')
    expect(notes.at(-1)?.message).toContain('Refusing to update')
    expect(backend.updateCalls).toEqual([])
  })

  it('aborts when the latest-tag lookup fails', async () => {
    const dir = tempAgentDir({ packages: [EGM_PACKAGE_SPEC] })
    const backend = fakeBackend({
      listRemoteTags: () => {
        throw new Error('offline')
      },
    })
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-update')
    expect(notes.at(-1)?.level).toBe('error')
    expect(backend.updateCalls).toEqual([])
  })

  it('unpins when updating to main', async () => {
    const dir = tempAgentDir({ packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] })
    const backend = fakeBackend()
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-update', 'main')
    expect(notes.at(-1)?.level).toBe('info')
    expect(readSettingsFile(join(dir, 'settings.json')).packages).toEqual([EGM_PACKAGE_SPEC])
    expect(backend.updateCalls).toEqual([{ ref: 'main', force: false }])
  })

  it('rejects unknown flags', async () => {
    const dir = tempAgentDir({ packages: [EGM_PACKAGE_SPEC] })
    const backend = fakeBackend()
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-update', '--bogus')
    expect(notes.at(-1)?.level).toBe('error')
    expect(notes.at(-1)?.message).toContain('Unknown option')
    expect(backend.updateCalls).toEqual([])
  })
})

describe('/egm-status', () => {
  it('reports revision, pin, and latest release', async () => {
    const dir = tempAgentDir({ packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] })
    const backend = fakeBackend({ headDescription: () => Promise.resolve('v0.1.0-54-g113a3af') })
    const notes = await harness({ agentDir: dir, backend }).invoke('egm-status')
    expect(notes.at(-1)?.message).toContain('v0.1.0-54-g113a3af')
    expect(notes.at(-1)?.message).toContain('pinned to v0.1.0')
    expect(notes.at(-1)?.message).toContain('latest release: v0.2.0')
  })

  it('survives unreadable settings', async () => {
    const dir = tempAgentDir()
    writeFileSync(join(dir, 'settings.json'), 'not json')
    const notes = await harness({ agentDir: dir, backend: fakeBackend() }).invoke('egm-status')
    expect(notes.at(-1)?.level).toBe('info')
    expect(notes.at(-1)?.message).toContain('tracking default branch')
  })
})
