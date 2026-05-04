# TP-012: Session State Module — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 0
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ⬜ Not Started

- [ ] Read `session-manager.ts` and `session-manager.test.ts`
- [ ] Read `conversation-state.ts` and `conversation-state.test.ts`
- [ ] Identify all coordination call sites in `main.ts`
- [ ] Identify `cleanupSessionById` usage in `internal-api.ts`

---

### Step 1: Create session-state.ts

**Status:** ⬜ Not Started

- [ ] Create `session-state.ts` with merged functionality and unified interface
- [ ] Implement single internal key derivation
- [ ] Implement asymmetric lifetime (cleanup vs evict)
- [ ] Preserve all existing conversation-state internals
- [ ] Run targeted tests

---

### Step 2: Create session-state.test.ts and update imports

**Status:** ⬜ Not Started

- [ ] Create `session-state.test.ts` with merged and expanded test coverage
- [ ] Update `main.ts` imports and simplify coordination logic
- [ ] Update `internal-api.ts` imports
- [ ] Delete old source and test files
- [ ] Run targeted tests

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes
- [ ] Verify no leaked imports from deleted modules

---

### Step 4: Documentation & Delivery

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
