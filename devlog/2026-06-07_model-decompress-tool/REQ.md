# REQ - Expose decompress tool to AI model

- Task ID: `2026-06-07_model-decompress-tool`
- Home Repo: `opencode-acp`
- Created: 2026-06-07
- Status: Draft
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/7

## 1. Background & Problem Statement

- **Context**: ACP currently exposes only the `compress` tool to the AI model. Decompression is available only via the `/acp decompress` slash command, requiring human intervention.
- **Current behavior (symptom)**: The model can compress conversation ranges but cannot restore them when it needs to reference original details. Users must manually run `/acp decompress` to restore compressed content.
- **Expected behavior**: The AI model should have a `decompress` tool that allows it to restore previously compressed blocks, enabling fully autonomous context management — compress AND decompress.
- **Impact**: Medium — improves model autonomy and reduces user intervention. The model can make more nuanced context decisions (compress early, decompress when original detail is needed).

## 2. Reproduction (if applicable)

- **Environment**: Any ACP-enabled session with compression active
- **Minimal reproduction steps**:
    1. Start a session with ACP enabled
    2. Let the model compress several conversation ranges
    3. Later, the model needs to reference original compressed content
    4. Model has no tool to restore it — user must manually run `/acp decompress <n>`
- **Relevant configuration**: Default ACP config (no special settings needed)

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: Must not change persisted state format, existing `/acp decompress` command must continue working
    - Must not expose `recompress` to the model (out of scope — recompress is costlier and less predictable)
    - Tool must respect existing permission system (`compress.permission` config)
    - Must handle context inflation — model should be aware decompressing restores full content
    - Must follow existing tool registration pattern from `compress` tool
- **Non-Goals** (explicitly out of scope):
    - Exposing `recompress` to the model (can be considered later)
    - Changing the existing `/acp decompress` slash command behavior
    - Adding new config options beyond what's needed for the tool
    - Modifying the GC system

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] New `decompress` tool is registered and callable by the model
    - [ ] Tool accepts `blockId` parameter (block reference like "b0", "b1", etc.)
    - [ ] Tool deactivates the specified block(s) and persists state
    - [ ] Next message-transform pipeline restores original messages
    - [ ] Nested blocks are handled correctly (same as `/acp decompress`)
    - [ ] Tool returns informative result message (restored messages count, tokens)
    - [ ] Tool is listed in `protectedTools` defaults so compress won't prune its output
- **Performance / Stability**:
    - [ ] No race conditions with concurrent compress/decompress
    - [ ] Tool execution is synchronous state mutation (same pattern as compress)
- **Regression**:
    - [ ] All existing tests pass
    - [ ] `npm run typecheck` passes
    - [ ] `npm run build` passes
    - [ ] `/acp decompress` command still works unchanged

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/compress/decompress.ts` — NEW: decompress tool implementation
    - `index.ts` — register decompress tool alongside compress
    - `lib/prompts/system.ts` — update system prompt to mention decompress
    - `lib/prompts/extensions/tool.ts` — add decompress format extension
    - `lib/prompts/store.ts` — add decompress prompt to prompt store (optional)
    - `lib/config.ts` — add decompress to protectedTools defaults
    - `tests/` — new test file for decompress tool
- **Risks**: Low — core decompress logic already exists and is battle-tested in `decompress.ts` command
- **Rollback strategy**: Revert branch
