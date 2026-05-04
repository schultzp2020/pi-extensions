# TP-006: Model normalization and effort mapping — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 0
**Size:** L

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ⬜ Not Started

- [ ] Required files exist (models.ts, config.ts from TP-003)
- [ ] Tests pass before changes

---

### Step 1: Create model normalization module

**Status:** ⬜ Not Started

- [ ] Implement `parseModelId()` with correct suffix stripping order
- [ ] Implement `processModels()` to deduplicate and build family metadata
- [ ] Implement `buildEffortMap()` with fallback chain
- [ ] Implement `resolveModelId()` for request-time reconstruction

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

| Timestamp  | Action      | Outcome                         |
| ---------- | ----------- | ------------------------------- |
| 2026-05-04 | Task staged | PROMPT.md and STATUS.md created |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
