# Task: TP-005 - Image content part bridging

**Created:** 2026-05-04
**Size:** S

## Review Level: 0 (None)

**Assessment:** Single-file change extending existing message parsing to preserve image content parts. No auth, no data model changes, easy revert.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-005-image-bridging/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Image-capable Cursor models advertise image input support, but
`openai-messages.ts` drops image content parts when normalizing messages.
The `textContent()` function filters for `type === 'text'` only, and the
message parsing pipeline never extracts or forwards image URLs or base64
data to the Cursor protobuf layer.

Preserve image content parts through the message parsing pipeline so they
can be bridged to Cursor's protobuf format. Models that support images
(e.g., GPT-5.4, Claude 4.x) should be able to receive screenshots and
diagrams sent by the user.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/openai-messages.ts`
- `packages/pi-cursor/src/proxy/openai-messages.test.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/openai-messages.ts` exists with `textContent()`, `parseMessages()`, `ContentPart` type
- [ ] `packages/pi-cursor/src/proxy/openai-messages.test.ts` exists with existing message parsing tests
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Preserve image content parts

In `packages/pi-cursor/src/proxy/openai-messages.ts`:

- Extend the `ContentPart` type to include `image_url?: { url: string; detail?: string }` for image URL parts (OpenAI format uses `type: 'image_url'`).
- Add an `ImagePart` type or extend `ContentPart` to represent extracted image data.
- Add a function `extractImageParts(content: string | ContentPart[] | null): ImagePart[]` that extracts image content parts from a message's content array. Returns empty array for string or null content.
- Modify `ParsedConversationTurn` and/or `ParsedMessages` to carry image parts alongside text. Add an `images` field where appropriate.
- Update `parseMessages()` to extract and preserve image parts from user messages, passing them through to the return value.

The actual protobuf encoding of images into Cursor's format will be handled in
`cursor-session.ts` when constructing the `UserMessageAction` — but the parsed
data must be available. Check the Cursor protobuf definitions in `proto/` to
understand how images are represented (likely as blob references or inline
binary).

- [ ] Extend `ContentPart` type to include image URL data
- [ ] Add image extraction function and carry image parts through `parseMessages()`
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/openai-messages.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

Extend `packages/pi-cursor/src/proxy/openai-messages.test.ts` with tests for:

- `extractImageParts()` — extracts image URLs from content arrays, returns empty for string content, handles mixed text+image content
- `parseMessages()` — preserves image parts from user messages, handles messages with only images, handles messages with text and images mixed
- `textContent()` — existing behavior unchanged (still returns text only)

- [ ] Add image content part tests to `openai-messages.test.ts`
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/openai-messages.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Add note about image bridging support in the message parsing layer

**Check If Affected:**

- `packages/pi-cursor/README.md` — Mention image support if capabilities are documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Image content parts survive `parseMessages()` and are accessible to downstream consumers
- [ ] `textContent()` behavior unchanged (returns text only)
- [ ] Existing message parsing tests still pass

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-005): complete Step N — description`
- **Bug fixes:** `fix(TP-005): description`
- **Tests:** `test(TP-005): description`
- **Hydration:** `hydrate: TP-005 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Implement protobuf encoding of images — that's a downstream concern in `cursor-session.ts`
- Change `textContent()` return value — it must still return text only

---

## Amendments (Added During Execution)
