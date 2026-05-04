# TP-009: Native tools mode with proxy-local execution — Status

**Current Step:** Step 1: Mode-dependent prompt guidance
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 1
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ✅ Done

- [x] Required files exist (request-context.ts, native-tools.ts, config.ts)
- [x] Tests pass before changes (187 passed, 0 failures)

---

### Step 1: Mode-dependent prompt guidance

**Status:** ✅ Done

- [x] Make prompt guidance conditional on native tools mode
- [x] Pass mode through to `buildRequestContext()` in main.ts

---

### Step 2: Mode-aware tool dispatch

**Status:** ⬜ Not Started

- [ ] Add `nativeToolsMode` to `MessageProcessorContext`
- [ ] Modify tool dispatch to branch on mode (reject/redirect/native)

---

### Step 3: Proxy-local native tool execution

**Status:** ⬜ Not Started

- [ ] Implement `resolveAllowedRoot()` and `validatePath()` for sandboxing
- [ ] Implement proxy-local execution for each overlapping tool type
- [ ] Pass `ctx.cwd` from extension to proxy for Allowed Root computation

---

### Step 4: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Add sandboxing and mode dispatch tests to `native-tools.test.ts`
- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes

---

### Step 5: Documentation & Delivery

**Status:** ⬜ Not Started

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged

---

## Reviews

| #   | Type | Step | Verdict | File |
| --- | ---- | ---- | ------- | ---- |

---

## Discoveries

| Discovery | Disposition | Location |
| --------- | ----------- | -------- |

---

## Execution Log

| Timestamp        | Action         | Outcome                          |
| ---------------- | -------------- | -------------------------------- |
| 2026-05-04       | Task staged    | PROMPT.md and STATUS.md created  |
| 2026-05-04 07:12 | Task started   | Runtime V2 lane-runner execution |
| 2026-05-04 07:12 | Step 0 started | Preflight                        |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
