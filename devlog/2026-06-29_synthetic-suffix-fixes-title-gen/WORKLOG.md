# WORKLOG — synthetic suffix fixes title generation

## Investigation

- Pulled GitHub issue #15 comments via `gh api` (webfetch had missed the
  dynamically-loaded comments). Reporter @kratky-pavel confirmed the bug still
  reproduces on acp **1.5.0** and shared the ACP daily log + context snapshot.
- The snapshot showed ACP turning a single `"ahoj"` user message into **two**
  user messages (the original plus an injected `"Compressed block context: …"`
  nudge). No `Skipping message transform for internal agent request` log line →
  PR #16's guard never fired (it targets a different code path).
- Read OpenCode `SessionPrompt.ensureTitle` (`prompt.ts:169-229`): precondition
  `input.history.filter(real).length !== 1` ⇒ requires exactly one real
  (`role==="user"` && not all-parts-synthetic) user message.
- Read the ensureTitle call site (`prompt.ts:1452-1458`): `title({ history: msgs })`
  is forked async (`Effect.forkIn`); `msgs` is the same array later mutated by
  `experimental.chat.messages.transform` (`prompt.ts:1574`) where ACP pushes the
  suffix user message — so the forked title effect can observe the mutated array.
- Located the injection: `createSuffixMessage` (`lib/messages/inject/inject.ts:49`)
  → `createSyntheticUserMessage` (`lib/messages/utils.ts:26`). Confirmed the
  created text part had **no** `synthetic` field.
- Confirmed `MessageV2.toModelMessagesEffect` (`message-v2.ts:791-806`) includes
  synthetic text parts (loop check is `type === "text" && !ignored`, no
  `synthetic` filter) ⇒ marking the part `synthetic` keeps the nudge in the LLM
  call. TUI already hides synthetic parts.

## Change

`lib/messages/utils.ts` — `createSyntheticUserMessage`: added `synthetic: true`
to the text part. Single-line, targeted fix. Benefits all callers (the compress
nudge suffix message and prune.ts compression summaries).

## Test

`tests/inject.test.ts` — added a contract test that replicates OpenCode's
`ensureTitle` `real` filter and asserts:

1. `createSyntheticUserMessage` produces a message whose parts are all
   `synthetic: true`.
2. That message is **not** a "real" user message.
3. A plain user message **is** real.
4. A `[base, synthetic]` conversation has **exactly one** real user message —
   i.e. `ensureTitle`'s precondition holds.

## Verification

- `npm run typecheck` — PASS (`synthetic` is valid on the Part type).
- `npm test` — PASS **487/487** (486 prior + 1 new), 0 fail.
- `npm run build` — PASS.

## Notes / follow-ups

- The fork's `37ecd0d` ("gate per-message nudge by context growth") does **not**
  touch `createSuffixMessage`, so the bug was present in both the gitea fork and
  upstream `@latest`; this fix applies to both.
- `isInternalAgentRequest` in `createChatMessageTransformHandler` is effectively
  dead code (OpenCode never sets `info.agent` to `title/summary/compaction` on
  user messages that reach `messages.transform`); left as harmless defense.
