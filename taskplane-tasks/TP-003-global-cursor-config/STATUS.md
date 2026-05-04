# TP-003: Global Cursor config with env override — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-04
**Review Level:** 0
**Review Counter:** 0
**Iteration:** 0
**Size:** S

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ⬜ Not Started

- [ ] Proxy directory exists and no existing `config.ts`
- [ ] Tests pass before changes

---

### Step 1: Create config module

**Status:** ⬜ Not Started

- [ ] Create `config.ts` with `CursorConfig` type, `DEFAULT_CONFIG`, and `CONFIG_PATH`
- [ ] Implement `loadConfig()` with per-field validation and graceful fallback
- [ ] Implement `saveConfig()` with directory creation and field merging
- [ ] Implement `resolveEffective()` with env var override precedence
- [ ] Implement `getEnvOverrides()` helper

---

### Step 2: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Create `config.test.ts` with load/save/resolve/override tests
- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes

---

### Step 3: Documentation & Delivery

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

| Timestamp  | Action      | Outcome                         |
| ---------- | ----------- | ------------------------------- |
| 2026-05-04 | Task staged | PROMPT.md and STATUS.md created |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
