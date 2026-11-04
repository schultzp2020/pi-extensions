import { join } from 'node:path'

/** The pi package spec under which the EGM git package is installed. */
export const EGM_PACKAGE_SPEC = 'git:github.com/google/elephant-goldfish-model'
export const EGM_REPO_URL = 'https://github.com/google/elephant-goldfish-model'

/** A remote tag: name plus the commit oid it (peels to) points at. */
export interface RemoteTag {
  name: string
  oid: string
}

/**
 * The git operations pi-egm needs, so no git binary has to exist on the PATH.
 * Implemented for real by createIsomorphicGitBackend (src/git.ts); faked in tests.
 */
export interface GitBackend {
  /** Remote tags of the EGM repository. */
  listRemoteTags(): Promise<RemoteTag[]>
  /** Whether the checkout carries local edits, deletions, or untracked files. */
  isDirty(checkout: string): Promise<boolean>
  /** Tag name when HEAD sits on a tag, else short commit hash (+ -dirty). */
  headDescription(checkout: string): Promise<string>
  /**
   * Move the checkout to ref (tag or branch from the EGM remote). Rejects a
   * dirty checkout unless force is set. Resolves to the new head description.
   */
  update(checkout: string, ref: string, options?: { force?: boolean }): Promise<string>
}

/** Location where pi checks out the EGM git package. Ref-independent. */
export function egmCheckoutDir(agentDir: string): string {
  return join(agentDir, 'git', 'github.com', 'google', 'elephant-goldfish-model')
}

/** Directory holding the goldfish persona agent definitions inside the checkout. */
export function egmAgentsDir(agentDir: string): string {
  return join(egmCheckoutDir(agentDir), 'agents')
}

/** Compare two version strings; positive when a > b. Tolerates a leading `v`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) {
      return d
    }
  }
  return 0
}

/** Highest `vX.Y.Z` tag from a remote tag list, or undefined when none exist. */
export function latestReleaseTag(tags: RemoteTag[]): string | undefined {
  return tags
    .map((tag) => tag.name)
    .filter((name) => /^v?\d+(\.\d+)*$/.test(name))
    .sort(compareVersions)
    .at(-1)
}

/** The pinned ref of the EGM package spec, or undefined when it tracks the default branch. */
export function pinnedRef(spec: string): string | undefined {
  return spec.startsWith(`${EGM_PACKAGE_SPEC}@`) ? spec.slice(EGM_PACKAGE_SPEC.length + 1) : undefined
}
