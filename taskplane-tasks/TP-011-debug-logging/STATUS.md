# TP-011: Structured debug logging and timeline — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-04
**Review Level:** 0
**Review Counter:** 0
**Iteration:** 0
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ⬜ Not Started

- [ ] Required files exist (main.ts, index.ts)
- [ ] No existing debug-logger.ts
- [ ] Tests pass before changes

---

### Step 1: Create debug logger module

**Status:** ⬜ Not Started

- [ ] Create `debug-logger.ts` with JSONL logging gated behind env var
- [ ] Implement all event type log functions
- [ ] Ensure zero overhead when disabled

---

### Step 2: Wire logging into proxy and extension

**Status:** ⬜ Not Started

- [ ] Wire debug logging into proxy request handling in `main.ts`
- [ ] Add extension-level lifecycle event logging in `index.ts`

---

### Step 3: Create timeline script

**Status:** ⬜ Not Started

- [ ] Create `debug-log-timeline.mjs` with JSONL parsing and timeline output
- [ ] Support filtering by session and time range
- [ ] Include summary statistics

---

### Step 4: Testing & Verification

**Status:** ⬜ Not Started

- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes
- [ ] Manual smoke test with debug logging enabled

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

| Timestamp  | Action      | Outcome                         |
| ---------- | ----------- | ------------------------------- |
| 2026-05-04 | Task staged | PROMPT.md and STATUS.md created |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
