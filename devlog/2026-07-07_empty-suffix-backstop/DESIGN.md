# DESIGN: Empty Suffix Message Backstop

## Architecture Impact

Minimal. No module boundaries or data-flow changes. Two surgical edits plus one
new pure utility function.

## Changes

### 1. Primary fix — `lib/messages/inject/inject.ts`

At the end of `injectCompressNudges`, replace the unconditional
`appendToLastTextPart(suffixMessage, "\n")` with a content check:

```ts
if (suffixMessage) {
    if (hasContent(suffixMessage)) {
        appendToLastTextPart(suffixMessage, "\n")
    } else {
        // Nothing was injected — remove the empty synthetic user message
        // so the model never sees an empty user turn (issue #12).
        const idx = messages.lastIndexOf(suffixMessage)
        if (idx !== -1) messages.splice(idx, 1)
    }
}
```

`hasContent` is already exported from `../utils` and is imported by
`injectMessageIds` in the same file. We add it to the existing import.

### 2. Backstop — `lib/messages/utils.ts`

New exported pure function:

```ts
export const dropEmptyUserMessages = (messages: WithParts[]): number => {
    let removed = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === "user" && !hasContent(messages[i])) {
            messages.splice(i, 1)
            removed++
        }
    }
    return removed
}
```

Iterates backwards so splices don't disturb unprocessed indices. Only touches
`role === "user"` — assistant messages (possibly mid-stream) are untouched.

### 3. Pipeline wiring — `lib/hooks.ts`

- Add `dropEmptyUserMessages` to the `./messages` import.
- Call it after `stripStaleMetadata(output.messages)` (the last mutation step
  before `logger.saveContext`), so it sees the final state of every message.

### 4. Barrel export — `lib/messages/index.ts`

Add `hasContent` and `dropEmptyUserMessages` to the `./utils` re-export so
`hooks.ts` can import `dropEmptyUserMessages` through the barrel.

## Why not fix the decision logic?

The 5%-growth-gated nudge was an intentional change (commit range
v1.8.1→v1.9.0) to reduce noise. Reverting it would re-introduce per-turn nudge
spam. The bug is that an unfilled suffix message leaks to the LLM — fixing that
directly is correct regardless of nudge strategy.

## Why backwards iteration in `dropEmptyUserMessages`?

Splicing forward shifts subsequent indices, forcing re-indexing or a skip.
Backwards iteration visits already-correct positions, so each splice is safe
without index bookkeeping.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Real user sends empty message → silently dropped | An empty user message has no content to act on; dropping it is strictly better than forwarding it to the LLM. |
| Future code path relies on suffix message existing | The suffix is transient (synthetic); nothing downstream indexes into it by position. `injectMessageIds` runs before the sweep and skips messages without a mapped ref. |
| `hasContent` returns false for tool-only messages | `hasContent` already treats completed tool outputs as content (see `utils.ts:215-225`). Only truly empty messages are dropped. |
