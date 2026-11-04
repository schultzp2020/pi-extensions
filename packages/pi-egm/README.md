# pi-egm

Wires [Google's Elephant-Goldfish Model (EGM)](https://github.com/google/elephant-goldfish-model)
into [Pi](https://github.com/badlogic/pi) when EGM is installed as a Pi git package
(`pi install git:github.com/google/elephant-goldfish-model`).

Pi already loads EGM's `skills/` (egm-bootstrap, egm-brainstorm, egm-draft, egm-review, …)
from the package checkout. This extension adds the two pieces Pi does not wire itself:

- **Goldfish personas as named subagents.** EGM's `agents/*.md` persona files
  (`egm-zoom-out`, `egm-comprehension`, `egm-design-critic`, …) are registered with
  pi-subagents by adding the checkout's `agents/` directory to `subagents.agentScanDirs`
  in `~/.pi/agent/settings.json`. Idempotent; runs at every startup, so new personas
  appear whenever the checkout changes.
- **Version-pinned updates.** `/egm-update` checks out the latest release tag (or a given
  ref, e.g. `/egm-update main` to track the default branch) in the package checkout and
  pins the package spec in `settings.json` (`git:…@v0.2.0`), so Pi's own package
  reconciliation keeps the checkout on that ref. `/egm-status` shows the current revision,
  the pin, and the latest release.

The extension is version independent: it depends only on the checkout path (which never
changes), the `agents/` directory inside it, and Pi's settings shape — never on EGM's
internal layout, tags, or release cadence. If EGM renames `agents/`, re-run
`pi install` and `/egm-update`; nothing else in this package needs to change.

## Install

```bash
pi install git:github.com/google/elephant-goldfish-model   # skills + checkout (if not present)
pi install /path/to/pi-extensions/packages/pi-egm           # this extension (build first)
```

Restart Pi afterwards; skills load at session start.

## Commands

| Command             | Effect                                                     |
| ------------------- | ---------------------------------------------------------- |
| `/egm-status`       | Current revision, pin state, latest release tag.           |
| `/egm-update`       | Latest release tag: check out + pin. Restart Pi to reload. |
| `/egm-update <ref>` | Any tag, branch, or commit. `main`/`master` unpins.        |

## Development

```bash
pnpm install
pnpm --filter @schultzp2020/pi-egm test
pnpm --filter @schultzp2020/pi-egm build
```
