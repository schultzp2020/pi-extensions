import fs from 'node:fs'

import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'

import { EGM_REPO_URL, type RemoteTag } from './egm.ts'

/** Peel a (possibly annotated) tag object oid down to its commit oid. */
async function peelToCommit(dir: string, oid: string): Promise<string> {
  let current = oid
  for (let depth = 0; depth < 10; depth++) {
    try {
      const { tag } = await git.readTag({ fs, dir, oid: current })
      current = tag.object
    } catch (error) {
      if ((error as { code?: string }).code === 'ObjectTypeError') {
        return current // not a tag object: this is the commit
      }
      throw error
    }
  }
  throw new Error(`tag object chain too deep at ${oid}`)
}

/**
 * GitBackend implemented with isomorphic-git — pure JavaScript, no git binary
 * or other tools required on the PATH. The remote is always the EGM repository.
 */
export function createIsomorphicGitBackend(repoUrl = EGM_REPO_URL) {
  /** Whether the checkout carries local edits, deletions, or untracked files. */
  async function isDirtyDir(dir: string): Promise<boolean> {
    // StatusRow = [filepath, head, workdir, stage]
    const matrix = await git.statusMatrix({ fs, dir, ignored: false })
    return matrix.some(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
  }

  return {
    /** Remote tags with annotated tags peeled to their commit oids. */
    async listRemoteTags(url: string = repoUrl): Promise<RemoteTag[]> {
      const refs = await git.listServerRefs({ http, url, prefix: 'refs/tags/', peelTags: true })
      return refs.map((ref) => ({ name: ref.ref.replace('refs/tags/', ''), oid: ref.oid }))
    },

    /** Whether the checkout carries local edits, deletions, or untracked files. */
    isDirty: isDirtyDir,

    /** Tag name when HEAD sits exactly on a tag, else the short commit hash (plus -dirty). */
    async headDescription(dir: string): Promise<string> {
      const head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
      const tagNames = await git.listTags({ fs, dir })
      let description: string | undefined
      for (const name of tagNames) {
        const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` })
        if ((await peelToCommit(dir, oid)) === head) {
          description = name
          break
        }
      }
      const dirty = (await isDirtyDir(dir)) ? '-dirty' : ''
      return `${description ?? head.slice(0, 7)}${dirty}`
    },

    /**
     * Move the checkout to ref (tag or branch name from the EGM remote):
     * fetch the single ref over HTTP, peel to its commit, force a detached
     * checkout at that commit. Local edits abort unless force is set.
     */
    async update(dir: string, ref: string, options: { force?: boolean } = {}): Promise<string> {
      if (!options.force && (await isDirtyDir(dir))) {
        throw new Error('EGM checkout has local edits; re-run with --force to discard them')
      }
      const remoteTags = await this.listRemoteTags()
      const isTag = remoteTags.some((tag) => tag.name === ref)
      const fullRef = isTag ? `refs/tags/${ref}` : `refs/heads/${ref}`
      const result = await git.fetch({ fs, http, dir, url: repoUrl, ref: fullRef, singleBranch: true })
      if (!result.fetchHead) {
        throw new Error(`ref not found on remote: ${ref}`)
      }
      const commit = await peelToCommit(dir, result.fetchHead)
      await git.checkout({ fs, dir, ref: commit, force: true })
      return this.headDescription(dir)
    },
  }
}

export type IsomorphicGitBackend = ReturnType<typeof createIsomorphicGitBackend>
