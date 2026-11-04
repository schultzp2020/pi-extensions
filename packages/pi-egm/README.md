# pi-egm

Wires [Google's Elephant-Goldfish Model (EGM)](https://github.com/google/elephant-goldfish-model)
into [Pi](https://github.com/badlogic/pi) when EGM is installed as a Pi git package
(`pi install git:github.com/google/elephant-goldfish-model`).

Pi already loads EGM's `skills/` (egm-bootstrap, egm-brainstorm, egm-draft, egm-review, …)
from the package checkout. This extension adds the two pieces Pi does not wire itself:

- **Goldfish personas as named subagents.** EGM's `agents/*.md` persona files
  (`egm-zoom-out`, `egm-comprehension`, `egm-design-critic`, …) are registered with
  pi-subagents by adding the checkout's `agents/` directory to `subagents.agentScanDirs`
  in `~/.pi/agent/settings.json`. Idempotent, runs under Pi's settings lock at every
  startup, and removes the entry again if the EGM checkout disappears.
- **Version-pinned updates.** `/egm-update` checks out the latest release tag (or a given
  ref, e.g. `/egm-update main` to track the default branch) in the package checkout and
  pins the package spec in `settings.json` (`git:…@v0.2.0`), so Pi's own package
  reconciliation keeps the checkout on that ref. `/egm-status` shows the current revision,
  the pin, and the latest release.

All git operations run through [isomorphic-git](https://isomorphic-git.org/) — pure
JavaScript, no git binary or other tools need to be on the PATH. The only other runtime
dependency is `proper-lockfile`, used to take Pi's own lock protocol on `settings.json`
so concurrent Pi processes cannot lose each other's writes.

## Install

```bash
pi install git:github.com/google/elephant-goldfish-model   # skills + checkout (if not present)
pi install /path/to/pi-extensions/packages/pi-egm           # this extension (build first)
```

Restart Pi afterwards; skills load at session start.

## Commands

| Command                     | Effect                                                  |
| --------------------------- | ------------------------------------------------------- |
| `/egm-status`               | Current revision, pin state, latest release tag.        |
| `/egm-update`               | Latest release tag: update + pin. Restart Pi to reload. |
| `/egm-update <ref>`         | Any tag or branch. `main`/`master` unpins.              |
| `/egm-update <ref> --force` | Discard local edits in the managed checkout first.      |

Update semantics: the checkout is fetched and moved first; only a successful move pins
`settings.json`. A dirty checkout (local edits, untracked files) aborts the update unless
`--force` is passed. `--force` overwrites tracked-file edits and removes nonignored
untracked files, leaving the managed checkout pristine; gitignored files (build
artifacts, local caches) are kept.

## Version independence and limits

The extension couples only to the checkout path (which never changes), the `agents/`
directory inside it, and Pi's settings shape. Limits to know:

- If EGM renames its `agents/` directory, this extension must be updated — the scan dir
  is a constant here, and neither `pi install` nor `/egm-update` rediscovers it.
- `/egm-update` resolves tags and branches against the EGM remote directly; it does not
  read the checkout's configured remotes.
- `pi install` of the EGM git package itself uses whatever Pi uses to clone; this
  extension's commands work without any local git installation.

## Development

```bash
pnpm install
pnpm --filter @schultzp2020/pi-egm test
pnpm --filter @schultzp2020/pi-egm build
```
