# TP-014: Request Lifecycle Module — Status

**Current Step:** Step 2: Slim down main.ts and retarget tests
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-04
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 1
**Size:** L

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ✅ Complete

- [x] Map the full `handleChatCompletion` path in `main.ts` — what moves vs. what stays
- [x] Read `session-state.ts` interface (from TP-012)
- [x] Read `openai-stream.ts` streaming/non-streaming delegation
- [x] Read `request-builder.test.ts` existing coverage
- [x] Identify module-level state for Proxy Context

---

### Step 1: Define Proxy Context and extract request-lifecycle.ts

**Status:** ✅ Complete

- [x] Define `ProxyContext` type
- [x] Create `request-lifecycle.ts` with `handleChatCompletion` and all internal helpers moved from `main.ts`
- [x] Export `buildRunRequest` and `foldTurnsIntoSystemPrompt` for testing
- [x] Run targeted tests

---

### Step 2: Slim down main.ts and retarget tests

**Status:** ⬜ Not Started

- [ ] Slim `main.ts` to ~200 lines (startup, routing, model mgmt, Internal API)
- [ ] Construct and pass `ProxyContext`
- [ ] Retarget `request-builder.test.ts` imports
- [ ] Create `request-lifecycle.test.ts` with retry, lineage, checkpoint, streaming tests
- [ ] Run targeted tests

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes
- [ ] Verify `main.ts` ~200 lines with no request handling logic
- [ ] Verify no imports from deleted modules

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

| Timestamp        | Action          | Outcome                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-04       | Task staged     | PROMPT.md and STATUS.md created                                                                                                                                                                                                                                                                                                                                                |
| 2026-05-04 19:31 | Task started    | Runtime V2 lane-runner execution                                                                                                                                                                                                                                                                                                                                               |
| 2026-05-04 19:31 | Step 0 started  | Preflight                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-05-04 19:32 | Step 0 complete | Preflight: main.ts mapped - lines 82-831 move to request-lifecycle.ts; lines 832-952 (main function, startup, model mgmt) stay. Module-level state: cachedNormalizedSet, getNormalizedModelSet, invalidateNormalizedModels stay in main.ts. ProxyContext needs: accessToken getter, getNormalizedSet, convConfig, cfg (nativeToolsMode, maxMode, maxRetries), debug logger fns |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
