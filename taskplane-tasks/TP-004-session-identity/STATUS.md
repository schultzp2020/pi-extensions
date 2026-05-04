# TP-004: Session identity from pi_session_id with lifecycle cleanup — Status

**Current Step:** Step 3: Add lifecycle cleanup and CancelAction
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-04
**Review Level:** 2
**Review Counter:** 0
**Iteration:** 1
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ✅ Done

- [x] Required files exist with expected exports
- [x] Tests pass before changes

---

### Step 1: Inject pi_session_id via before_provider_request

**Status:** ✅ Done

- [x] Register `before_provider_request` hook to inject `pi_session_id` into request body
- [x] Replace random UUID with real Pi session ID

---

### Step 2: Stabilize session key derivation

**Status:** ✅ Done

- [x] Stabilize `deriveSessionKey()` and `deriveConversationKey()` to use session ID only
- [x] Extract `pi_session_id` from request body in `main.ts` with header fallback

---

### Step 3: Add lifecycle cleanup and CancelAction

**Status:** ✅ Done

- [x] Add `session_before_switch`, `session_before_fork`, `session_before_tree` hooks
- [x] Add session cleanup endpoint/function for proxy
- [x] Send CancelAction protobuf on client disconnect
- [x] Preserve previous checkpoint on interrupted turns

---

### Step 4: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Session key stability verified
- [ ] Lifecycle hooks registered and callable
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
| 2026-05-04 05:55 | Task started   | Runtime V2 lane-runner execution |
| 2026-05-04 05:55 | Step 0 started | Preflight                        |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
