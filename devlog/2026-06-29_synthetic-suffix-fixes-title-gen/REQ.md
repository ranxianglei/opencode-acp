# REQ — synthetic suffix messages must not break OpenCode title generation

## Problem

When `opencode-acp` is loaded, OpenCode's built-in session title generation
never runs: new sessions stay named `New session - <timestamp>` indefinitely
(GitHub issue #15, confirmed reproducing on acp 1.5.0 by @kratky-pavel).

## Root cause

OpenCode's `SessionPrompt.ensureTitle` (`packages/opencode/src/session/prompt.ts`)
has a hard precondition:

```ts
const real = (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
if (input.history.filter(real).length !== 1) return // requires EXACTLY 1 real user message
```

ACP's message-transform pipeline injects a "Compressed block context" nudge as a
**second, standalone user message** (`createSuffixMessage` →
`createSyntheticUserMessage`, `lib/messages/inject/inject.ts` + `lib/messages/utils.ts`).
`createSyntheticUserMessage` built the message's text part **without** the
`synthetic: true` flag, so `ensureTitle`'s `real` filter counted it as a real
user message → `filter(real).length` became 2 → the precondition failed →
title generation was never scheduled (the title LLM stream never starts).

This is a different code path from PR #16's `isInternalAgentRequest` guard
(which only handles the case where an internal-agent request itself flows
through `messages.transform`). The bug here is the **main-chat** transform
injection breaking title **scheduling**.

## Requirement

ACP-injected user messages must NOT be counted as "real" user messages by
OpenCode's `ensureTitle`, while still delivering their text to the LLM and being
hidden from the TUI — i.e. they must behave exactly like OpenCode's own
synthetic parts (compaction summaries, plan parts).

## Approach

Mark the part created by `createSyntheticUserMessage` with `synthetic: true`
(the function is literally named "synthetic" but never set the flag — a latent
bug). Verified that OpenCode's `MessageV2.toModelMessagesEffect` includes
synthetic text parts in the LLM call (it checks only `type === "text" &&
!part.ignored`, with no `synthetic` filter), so the nudge text is still
delivered.
