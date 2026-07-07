# REQ: Empty Suffix Message Backstop (Issue #12)

## Problem

The model repeatedly complains that the user sent an empty message. Root cause:
ACP's `injectCompressNudges` unconditionally pushes a synthetic user "suffix"
message (`createSuffixMessage`) at the end of the message array every turn, then
conditionally fills it with dynamic guidance (context-usage tag, breakdown,
nudge, tool-output reminder).

After the v1.9.0 change from per-turn injection to **5%-growth-gated** injection
(`nudgeGrowthTokens`), the suffix stays empty on most turns:

- `applyAnchoredNudges` only writes when anchors exist (context ≥ 45%).
- `decision.shouldNudge` is false unless token growth ≥ 5% of context limit.
- `toolOutputReminder` only fires when tool-output growth ≥ 5000 tokens.

When none fire, the empty synthetic user message is sent to the LLM verbatim,
and the model interprets it as "the user sent an empty message".

The existing `appendToLastTextPart(suffixMessage, "\n")` line at the end of
`injectCompressNudges` was intended as a backstop but is a **no-op** —
`appendToTextPart` guards against whitespace-only injections.

## Acceptance Criteria

1. When the suffix synthetic message receives no content during a turn, it MUST
   be removed from the message array before the LLM sees it.
2. A general backstop MUST sweep any empty user-role messages (no non-whitespace
   text AND no completed tool output) from the array at the end of the message
   transform pipeline — so future bugs in any code path that produces empty
   user messages are also caught.
3. When the suffix DOES have content, the trailing `"\n"` separator MUST still
   be applied (existing behavior preserved).
4. No real user content is ever dropped — only messages where `hasContent`
   returns false.
5. New unit tests cover: (a) `dropEmptyUserMessages` removes empty user
   messages, preserves non-empty ones, preserves empty assistant messages;
   (b) the suffix-splice path in `injectCompressNudges`.

## Constraints

- Minimal change. No refactoring of the nudge decision logic itself.
- Backstop must not remove assistant messages (may be mid-stream).
- Must not regress the 407 existing tests.
- Follow AGENTS.md commit/review/devlog workflow.
