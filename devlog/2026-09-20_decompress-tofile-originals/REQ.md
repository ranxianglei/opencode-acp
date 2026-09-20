# REQ - decompress.toFile exports original text instead of falling back to the summary

- Task ID: `2026-09-20_decompress-tofile-originals`
- Home Repo: `opencode-acp`
- Created: 2026-09-20
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/445 ; related #415 / #416 (toFile path/symlink safety — separate concern)

## 1. Background & Problem Statement

- **Context**: `decompress` with a `toFile` argument writes restored block content to a file instead of inflating context. For an **active** block whose originals are still retrievable from session history, the file should contain the **original message text**, not the compression summary. The ordinary context-restoration path (`deactivateCompressionTarget` + `syncCompressionBlocks`) is separate and not what this task addresses.
- **Current behavior (symptom)**: An active block with retrievable originals exports its **summary** instead of the original text, while still returning a *successful* export message ("N messages written to …"). The user gets a lossy summary believing they got the raw content.
- **Root cause layering** (all in `lib/compress/decompress.ts`):
    1. `fetchSessionMessages` returns validated `WithParts` records shaped `{ info: { id, role, sessionID, time }, parts: [...] }` (`lib/state/types.ts`, `lib/messages/shape.ts`). The canonical ID access everywhere else is `msg.info.id` (e.g. `lib/compress/search.ts:27`).
    2. `extractMessageId(m)` read top-level `(m as { id? }).id ?? (m as { messageId? }).messageId ?? ""` → for real SDK-shaped records this is **always `""`** → the `rawMessages.filter((m) => msgIdSet.has(extractMessageId(m)))` step matches **zero** messages.
    3. `extractMessageText(m)` read top-level `m.role` / `m.content` / `m.text` rather than `m.info.role` + `m.parts` → even if IDs matched, text extraction would be empty/garbage.
    4. The toFile branch then took the `lines.length > 0 ? … : summary` fallback with zero lines, wrote the block summary, and reported success. Fixing only ID selection would still leave empty text — both helpers must be corrected together.
- **Impact**: silent data-fidelity loss on the `decompress toFile` recovery path; users cannot recover original detail they compressed, defeating the purpose of `full`/`toFile` restoration.

## 2. Reproduction

- **Environment**: any ACP session; dependency-free Node check (issue reporter used `node:module.stripTypeScriptTypes`) or the new test below.
- **Minimal reproduction** (fixture from issue #445):
    ```js
    const message = {
      info: { id: "msg-raw-1", sessionID: "ses-repro", role: "assistant", time: { created: 1 } },
      parts: [{ id: "part-1", messageID: "msg-raw-1", sessionID: "ses-repro", type: "text", text: "ORIGINAL DETAIL 42" }],
    };
    ```
    Observed pre-fix: `acceptedByProductionShapeFilter=1`, `extractedId=""`, `matchedOriginalMessages=0`, `exportWouldFallBackToSummary=true`. Filtering by `m.info.id` matches the same message.
- **Deterministic regression test added**: `tests/active-block-decompress-tofile.test.ts` drives `createDecompressTool(...).execute({ blockId, toFile })` end-to-end against an active block with a real SDK-shaped history containing an original-only sentinel.

## 3. Constraints & Non-Goals

- **Constraints**:
    - MUST resolve original IDs from `info.id` and serialize role/content from `info.role` + `parts`, including relevant **text** and **tool** output.
    - MUST distinguish a **true missing-original fallback** (inactive/consumed block whose history is gone) from a **successful raw-content export**; the returned message must reflect which happened.
    - No new dependencies; reuse existing `extractToolContent` from `lib/token-utils.ts` so exported tool text matches token accounting.
    - Preserved behavior: block stays compressed (context unchanged) — `toFile` only affects the written file and the returned note.
    - Keep diff minimal: no unrelated reformatting (repo has Prettier version drift — see WORKLOG lessons).
- **Non-Goals**:
    - Not changing the path/symlink safety of `toFile` (tracked separately in #415 / #416).
    - Not changing the ordinary decompress (in-context restoration) flow.
    - Not altering block lifecycle (activation/deactivation) semantics.

## 4. Acceptance Criteria

- **Correctness**:
    - [ ] Active block whose originals are present → exported file contains the original text (sentinel present), NOT the summary.
    - [ ] Mixed text + tool parts serialized: roles from `info.role`, text parts verbatim, tool parts labeled `[name]` with input/completed output via `extractToolContent`.
    - [ ] Structural parts (reasoning / step markers) skipped without throwing.
    - [ ] Active block whose originals are genuinely absent (ids not in fetched history) → falls back to stored summary, and the returned message says "no original messages found; wrote block summary".
    - [ ] Successful raw export message reports the original-message count (e.g. "2 original messages"), not the ambiguous old phrasing when a fallback occurred.
    - [ ] Block remains active after toFile (state unchanged).
- **Performance / Stability**:
    - [ ] typecheck clean; full test suite green (modulo the two known pre-existing sandbox `/tmp` artifacts).
    - [ ] No per-message allocation beyond a linear pass over `parts`.
- **Regression tests**:
    - [ ] New E2E test fails against the unfixed code (verified by stashing the fix) and passes with the fix.
    - [ ] Covers mixed text/tool parts and distinguishes true fallback from successful raw export.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/compress/decompress.ts`:
        - `extractMessageId(m)` → `return m?.info?.id ?? ""`.
        - New module-private `type MessagePart = WithParts["parts"][number]` and `serializeMessagePart(part): string | null` (text passthrough; tool via `extractToolContent`; everything else null).
        - `extractMessageText(m)` → build `[role]\n<segments>` from `m.info.role` + serialized `m.parts`.
        - toFile branch → compute `sourceNote`; raw path joins lines, fallback path writes `targets[0]?.blocks[0]?.summary`; return message uses `sourceNote`.
        - Import `extractToolContent` from `../token-utils`.
    - `tests/active-block-decompress-tofile.test.ts` — NEW E2E regression suite (real SDK-shaped history, active block, sentinel-based raw-vs-summary assertion, mixed text/tool, genuine-missing fallback case).
- **Why reuse `extractToolContent`**: it already normalizes completed tool output/error into strings for token counting; reusing it keeps the exported text faithful to what ACP counts and avoids a second parsing implementation.
- **Risks**: none material — localized to two pure helpers + one branch; no state format, persistence, config schema, or public API change.
- **Rollback strategy**: Revert the single commit; behavior reverts exactly.
