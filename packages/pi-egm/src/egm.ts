import { join } from 'node:path'

/** The pi package spec under which the EGM git package is installed. */
export const EGM_PACKAGE_SPEC = 'git:github.com/google/elephant-goldfish-model'
export const EGM_REPO_URL = 'https://github.com/google/elephant-goldfish-model'

/** A git runner: runs `git <args>` optionally in cwd, resolves to trimmed stdout. */
export interface GitRunner {
  (args: string[], opts?: { cwd?: string }): Promise<string>
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

/** Highest `vX.Y.Z` tag reachable via ls-remote, or undefined when none exist. */
export async function latestReleaseTag(run: GitRunner, repoUrl = EGM_REPO_URL): Promise<string | undefined> {
  const out = await run(['ls-remote', '--tags', '--refs', repoUrl])
  const tags = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t')[1]?.replace('refs/tags/', '') ?? '')
    .filter((tag) => /^v?\d+(\.\d+)*$/.test(tag))
  return tags.sort(compareVersions).at(-1)
}

/** Human-readable description of the checked-out EGM revision. */
export async function checkoutDescription(run: GitRunner, checkout: string): Promise<string> {
  try {
    return await run(['describe', '--tags', '--always', '--dirty'], { cwd: checkout })
  } catch {
    // not a tagged checkout: fall back to the short hash
  }
  return run(['rev-parse', '--short', 'HEAD'], { cwd: checkout })
}

/** Fetch tags and check out ref in the pi-managed EGM checkout. */
export async function updateCheckout(run: GitRunner, checkout: string, ref: string): Promise<string> {
  await run(['fetch', '--tags', '--force', 'origin'], { cwd: checkout })
  await run(['checkout', '--force', ref], { cwd: checkout })
  return checkoutDescription(run, checkout)
}

/** The pinned ref of the EGM package spec, or undefined when it tracks the default branch. */
export function pinnedRef(spec: string): string | undefined {
  return spec.startsWith(`${EGM_PACKAGE_SPEC}@`) ? spec.slice(EGM_PACKAGE_SPEC.length + 1) : undefined
}
