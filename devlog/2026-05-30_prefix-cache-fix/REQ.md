# REQ - Fix dynamic nudges breaking OpenAI Responses prefix cache

- Task ID: `2026-05-30_prefix-cache-fix`
- Home Repo: `opencode-acp`
- Created: 2026-05-30
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/5

## 1. Background & Problem Statement

- **Context**: OpenAI Responses API uses prefix-based prompt caching. The token prefix must remain byte-stable between requests for cache hits to grow.
- **Current behavior (symptom)**: ACP injects dynamic per-turn metadata (`Context usage`, `Visible message IDs`, `Compressed block context`) into the **last user message** on every `chat.messages.transform` call. Because this user message is often early in the conversation (before many tool outputs), changing it invalidates the prefix for all subsequent content. Cache read tokens plateau at ~25.6K while total prompt tokens grow from 38K to 83K.
- **Expected behavior**: Dynamic ACP metadata should not rewrite historical messages. All per-turn dynamic content should be placed in a synthetic message at the END of the message list, so prefix cache can grow to cover all historical content.
- **Impact**: High — every turn wastes 30-50K+ tokens in non-cached input that should be cache hits. Directly increases API cost for OpenAI Responses users.

## 2. Reproduction (if applicable)

- **Environment**:
  - OpenAI Responses API (`POST /v1/responses`)
  - Model: `openai/gpt-5.4`
  - ACP enabled with default config
- **Minimal reproduction steps**:
  1. Enable ACP plugin
  2. Start a session with OpenAI Responses model
  3. Send a message, then let the model make several tool calls (read, grep, etc.)
  4. Observe `cached_tokens` stops growing after ~2 turns
- **Relevant configuration**: Default ACP config (no special settings needed)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: Must not change persisted state format or config schema
  - Must not affect Anthropic/Gemini caching (different mechanism)
  - Synthetic suffix message must not interfere with message ID assignment or compress tool
- **Non-Goals** (explicitly out of scope):
  - Changing `injectMessageIds` tag injection (tags are stable once assigned per message, less impactful)
  - Optimizing other prompt cache providers (focus on OpenAI Responses prefix cache)

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `injectContextUsage`, `injectVisibleIdRange`, `buildCompressedBlockGuidance` write to a suffix message at the END of the message list
  - [ ] Historical user messages are NOT modified by these functions
  - [ ] Anchored nudges also write to the suffix message
  - [ ] Compress tool still works correctly with suffix message present
- **Performance / Stability**:
  - [ ] No new message ID refs assigned to the suffix message
  - [ ] Suffix message does not appear in compress boundary resolution
- **Regression**:
  - [ ] All 350 existing tests pass
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` passes

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/inject.ts` — Add `createSuffixMessage()`, modify `injectContextUsage`, `injectVisibleIdRange`, and block guidance injection in `injectCompressNudges`
  - `lib/messages/inject/utils.ts` — Add `suffixMessage` parameter to `applyAnchoredNudges`
- **Risks**: Low — changes are localized to injection targets, no data format changes
- **Rollback strategy**: Revert commit on this branch
