# TP-006: Model normalization and effort mapping — Status

**Current Step:** Step 1: Create model normalization module
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 2
**Size:** L

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ✅ Complete

- [x] Required files exist (models.ts, config.ts from TP-003)
- [x] Tests pass before changes (127 tests, 10 files)

---

### Step 1: Create model normalization module

**Status:** ✅ Complete

- [x] Implement `parseModelId()` with correct suffix stripping order
- [x] Implement `processModels()` to deduplicate and build family metadata
- [x] Implement `buildEffortMap()` with fallback chain
- [x] Implement `resolveModelId()` for request-time reconstruction

---

### Step 2: Integrate normalization into model registration

**Status:** ⬜ Not Started

- [ ] Integrate normalization into `/v1/models` endpoint based on `modelMappings`
- [ ] Add effort resolution at request time in chat completion handler
- [ ] Set provider compat fields for reasoning effort support in `index.ts`
- [ ] Create `cursor-models-raw.json` fallback model list

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Create `model-normalization.test.ts` with comprehensive tests
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

| Timestamp        | Action         | Outcome                           |
| ---------------- | -------------- | --------------------------------- |
| 2026-05-04       | Task staged    | PROMPT.md and STATUS.md created   |
| 2026-05-04 06:17 | Task started   | Runtime V2 lane-runner execution  |
| 2026-05-04 06:17 | Step 0 started | Preflight                         |
| 2026-05-04 06:27 | Worker iter 1  | done in 601s, tools: 23           |
| 2026-05-04 06:27 | Step 1 started | Create model normalization module |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
