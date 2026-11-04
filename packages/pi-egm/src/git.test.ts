import fs, { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import git from 'isomorphic-git'
import { afterEach, describe, expect, it } from 'vitest'

import { createIsomorphicGitBackend } from './git.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const AUTHOR = { name: 'pi-egm test', email: 'test@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 }

/** A local repo built with isomorphic-git itself — no git binary, no network. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-egm-git-'))
  tempDirs.push(dir)
  await git.init({ fs, dir })
  for (const [path, content] of Object.entries(files)) {
    fs.writeFileSync(join(dir, path), content)
    await git.add({ fs, dir, filepath: path })
  }
  await git.commit({ fs, dir, message: 'fixture', author: AUTHOR })
  return dir
}

describe('createIsomorphicGitBackend', () => {
  it('reports a clean checkout as not dirty', async () => {
    const dir = await fixture({ 'a.txt': 'one' })
    expect(await createIsomorphicGitBackend().isDirty(dir)).toBeFalsy()
  })

  it('detects modified and untracked files as dirty', async () => {
    const backend = createIsomorphicGitBackend()
    const dir = await fixture({ 'a.txt': 'one' })
    fs.writeFileSync(join(dir, 'a.txt'), 'two')
    expect(await backend.isDirty(dir)).toBeTruthy()
    fs.writeFileSync(join(dir, 'a.txt'), 'one')
    fs.writeFileSync(join(dir, 'b.txt'), 'untracked')
    expect(await backend.isDirty(dir)).toBeTruthy()
  })

  it('describes HEAD by tag name when it sits on a tag, with -dirty suffix for edits', async () => {
    const backend = createIsomorphicGitBackend()
    const dir = await fixture({ 'a.txt': 'one' })
    expect(await backend.headDescription(dir)).toMatch(/^[0-9a-f]{7}$/)
    await git.tag({ fs, dir, ref: 'v1.2.3' })
    expect(await backend.headDescription(dir)).toBe('v1.2.3')
    fs.writeFileSync(join(dir, 'a.txt'), 'two')
    expect(await backend.headDescription(dir)).toBe('v1.2.3-dirty')
  })

  it('peels annotated tag objects to their commit', async () => {
    const backend = createIsomorphicGitBackend()
    const dir = await fixture({ 'a.txt': 'one' })
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
    // An annotated tag points at a tag object, not directly at the commit.
    const tagOid = await git.writeTag({
      fs,
      dir,
      tag: { object: head, type: 'commit', tag: 'v2.0.0', tagger: AUTHOR, message: 'release', gpgsig: '' },
    })
    await git.writeRef({ fs, dir, ref: 'refs/tags/v2.0.0', value: tagOid })
    expect(await backend.headDescription(dir)).toBe('v2.0.0')
  })

  it('update rejects a dirty checkout without force and never fetches', async () => {
    const backend = createIsomorphicGitBackend()
    const dir = await fixture({ 'a.txt': 'one' })
    fs.writeFileSync(join(dir, 'a.txt'), 'edited')
    await expect(backend.update(dir, 'v0.1.0')).rejects.toThrow(/local edits/)
  })
})
