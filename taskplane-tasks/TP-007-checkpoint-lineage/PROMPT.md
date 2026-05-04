# Task: TP-007 - Checkpoint lineage for fork and compaction safety

**Created:** 2026-05-04
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Adds lineage metadata to conversation state persistence. Adapts existing state management patterns with new fingerprint/validation logic. Touches data persistence format but no auth.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Canonical Task Folder

```
taskplane-tasks/TP-007-checkpoint-lineage/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Without lineage validation, the proxy reuses stale checkpoints after forks,
compaction, or branch navigation. Cursor sees inconsistent conversation state
and produces garbled responses or errors.

Add lightweight lineage metadata (completed turn count + SHA256 fingerprint of
completed structured history) alongside each committed checkpoint. Validate
lineage on every request — discard the checkpoint on mismatch and reconstruct
turns from the message history Pi sends.

## Dependencies

- **Task:** TP-004 (stable session identity must exist — lineage validation relies on session-ID-based key derivation so that compaction doesn't change the key itself)

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/docs/adr/0008-checkpoint-lineage-for-fork-and-compaction-safety.md` — lineage design, mismatch detection, commit rules

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/conversation-state.ts`
- `packages/pi-cursor/src/proxy/conversation-state.test.ts`
- `packages/pi-cursor/src/proxy/main.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/conversation-state.ts` exists with `StoredConversation`, `getConversationState`, `persistConversation`
- [ ] `packages/pi-cursor/src/proxy/main.ts` calls `getConversationState` and `persistConversation`
- [ ] Session identity changes from TP-004 are present
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Add lineage metadata to StoredConversation

In `packages/pi-cursor/src/proxy/conversation-state.ts`:

- Add lineage fields to `StoredConversation`: `lineageTurnCount: number` and
  `lineageFingerprint: string | null`. Default both to `0` and `null` for
  backward compat with existing stored conversations.
- Add `LineageMetadata` interface: `{ turnCount: number; fingerprint: string }`.
- Implement `computeLineageFingerprint(turns: ParsedConversationTurn[]): string`
  — SHA256 hash of serialized completed turns. Import `ParsedConversationTurn`
  from `openai-messages.ts`.
- Implement `validateLineage(stored: StoredConversation, incoming: LineageMetadata): boolean`
  — returns `false` if turn count or fingerprint mismatch.
- Implement `shouldDiscardCheckpoint(stored: StoredConversation, incoming: LineageMetadata): boolean`
  — returns `true` when lineage is invalid AND checkpoint is non-null.
- Update `persistConversation()` to accept and store lineage metadata.
- Update disk serialization format to include lineage fields.

- [ ] Add lineage fields and types to `StoredConversation`
- [ ] Implement `computeLineageFingerprint()`, `validateLineage()`, `shouldDiscardCheckpoint()`
- [ ] Update persistence to store/load lineage metadata
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/conversation-state.ts` (modified)

### Step 2: Validate lineage on every request

In `packages/pi-cursor/src/proxy/main.ts`:

- Before using a stored conversation's checkpoint, compute lineage from the
  incoming message history (turn count + fingerprint of completed turns).
- Call `validateLineage()` — if mismatch, discard the checkpoint (set to `null`)
  and clear checkpoint history/archive. The proxy will reconstruct turns from
  the message history Pi sends.
- After a turn completes successfully, compute and store the updated lineage
  (new turn count and fingerprint including the just-completed turn).
- On interrupted turns (client disconnect, error), do NOT update lineage —
  preserve the previous committed lineage.

- [ ] Compute incoming lineage from message history before using checkpoint
- [ ] Discard stale checkpoint on lineage mismatch
- [ ] Update lineage only after successful turn completion
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/main.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

Extend `packages/pi-cursor/src/proxy/conversation-state.test.ts` with tests for:

- `computeLineageFingerprint()` — deterministic output, different turns produce different fingerprints
- `validateLineage()` — matching lineage passes, turn count mismatch fails, same-depth fork (same count, different fingerprint) fails
- `shouldDiscardCheckpoint()` — returns true on mismatch with non-null checkpoint, false on mismatch with null checkpoint, false on valid lineage
- Backward compat — stored conversations without lineage fields load correctly with defaults

- [ ] Add lineage tests to `conversation-state.test.ts`
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/conversation-state.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add "Checkpoint Lineage" definition describing the turn count + fingerprint validation mechanism

**Check If Affected:**

- `packages/pi-cursor/README.md` — Update if checkpoint/session behavior is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Stale checkpoints are discarded on turn count mismatch
- [ ] Same-depth forks (same turn count, different fingerprint) are detected
- [ ] Lineage is only updated after successful turn completion
- [ ] Existing conversations without lineage fields load without errors

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-007): complete Step N — description`
- **Bug fixes:** `fix(TP-007): description`
- **Tests:** `test(TP-007): description`
- **Hydration:** `hydrate: TP-007 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Break backward compat with existing stored conversations
- Commit checkpoints or update lineage on interrupted turns

---

## Amendments (Added During Execution)
