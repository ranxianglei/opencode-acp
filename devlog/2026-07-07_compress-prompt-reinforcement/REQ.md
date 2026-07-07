# REQ — Compress summary-structure prompt reinforcement

## Background

PR #63 added a 4-point SUMMARY STRUCTURE to the compress tool *description*
(`lib/prompts/compress-range.ts` + `compress-message.ts`). Investigation of an
ML-research session (`ses_0cf8549c4ff`, block 38 "B知识图谱") showed the model
was **not** following the new structure: block 38 was a dense data-dump with
pointer-refs (`EDITING_REPORT §4.2`) instead of transcribed content, points ③④
missing entirely, and truncation at the length limit.

Root cause is **few-shot interference**: that session already carried 37 older
summaries written under the previous (unstructured) format. In-context examples
overpower tool-description instructions, so the model mimics the legacy dense
style and ignores the 4-point structure buried in the tool description.

## Problem

The SUMMARY STRUCTURE prompt lives **only** in the `compress` tool's
`description` field — it is never surfaced in the system prompt or at the
compress call-to-action. Two weaknesses:

1. **Low prompt weight** — tool descriptions are read once; the structure is
   easily drowned out by 37 in-context counter-examples.
2. **Far from the action point** — when the nudge fires and tells the model to
   compress, there is no reminder of the required structure at that moment.

## Constraints

- Token budget is not a concern (user confirmed: relative to huge contexts this
  is negligible). Reinforcement can be added in two places without worry.
- Must not duplicate the full tool-description text verbatim (that lives in the
  editable prompts); the system-prompt version is a concise reinforcement.
- Must not break the 6 editable-prompt override mechanism or existing tests.
- No type-safety regressions; no `as any` / `@ts-ignore`.

## Acceptance Criteria

1. **(a) System-prompt reinforcement** — `lib/prompts/system.ts` gains a
   `SUMMARY STRUCTURE` section that restates the 4 points concisely AND includes
   an explicit anti-mimicry note ("do **not** mimic the style of existing
   summaries already in context — many were written under an older format").
2. **(b) Nudge-time reminder** — when a compress nudge fires
   (`lib/messages/inject/inject.ts`), a one-line reminder is appended right
   after the "💡 Compress incrementally" tip, pointing to the SUMMARY STRUCTURE
   and repeating the anti-mimicry warning.
3. `npm run typecheck` passes (exit 0).
4. `npm run build` succeeds; new strings present in `dist/index.js`.
5. Test suite green (563 pass; 1 pre-existing bun-incompat fail in
   `prompts.test.ts` unrelated to this change).

## Approach

Two surgical string edits, no logic changes:

- **system.ts** — insert `SUMMARY STRUCTURE` section between the `TOOLS`
  (high position → high attention, adjacent to the tool it governs) and
  `COMPRESSION PHILOSOPHY` sections.
- **inject.ts** — append one `\n📝 New summaries must follow the SUMMARY
  STRUCTURE …` line to the breakdown string built when
  `decision.shouldNudge === true`, immediately after the incremental-compress
  tip.

No new config, no state changes, no test changes (both edits are prompt text).

## Out of scope

- Decompress-tool documentation (D3 — deferred until D4 tool ready).
- Changing the compress tool description itself (already done in PR #63).
- Re-running the ML session to measure conformance (requires user restart).
