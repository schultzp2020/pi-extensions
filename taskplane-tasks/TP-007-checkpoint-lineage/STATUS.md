# TP-007: Checkpoint lineage for fork and compaction safety — Status

**Current Step:** Step 1: Add lineage metadata to StoredConversation
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 2
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ✅ Done

- [x] Required files exist with expected exports
- [x] TP-004 changes present (stable session identity)
- [x] Tests pass before changes

---

### Step 1: Add lineage metadata to StoredConversation

**Status:** ✅ Done

- [x] Add lineage fields and types to `StoredConversation`
- [x] Implement `computeLineageFingerprint()`, `validateLineage()`, `shouldDiscardCheckpoint()`
- [x] Update persistence to store/load lineage metadata

---

### Step 2: Validate lineage on every request

**Status:** ⬜ Not Started

- [ ] Compute incoming lineage from message history before using checkpoint
- [ ] Discard stale checkpoint on lineage mismatch
- [ ] Update lineage only after successful turn completion

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Add lineage tests to `conversation-state.test.ts`
- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes

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

| Timestamp        | Action         | Outcome                                         |
| ---------------- | -------------- | ----------------------------------------------- |
| 2026-05-04       | Task staged    | PROMPT.md and STATUS.md created                 |
| 2026-05-04 06:40 | Task started   | Runtime V2 lane-runner execution                |
| 2026-05-04 06:40 | Step 0 started | Preflight                                       |
| 2026-05-04 06:41 | Worker iter 1  | done in 10s, tools: 2                           |
| 2026-05-04 06:41 | No progress    | Iteration 1: 0 new checkboxes (1/3 stall limit) |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
