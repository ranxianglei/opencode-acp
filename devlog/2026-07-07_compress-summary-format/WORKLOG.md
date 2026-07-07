# WORKLOG: Compression summary format guidance (issue #9)

## Summary

Added a `SUMMARY STRUCTURE` section to both compress prompts (range + message)
giving the model a three-point structure for organizing summaries: what the
range covers, critical content transcribed verbatim, and what is recoverable +
when. The structure is explicitly **not mandatory** — empty points are omitted
and the model is told not to invent material to fill the template.

Per user decision D3, the "do not push the reader to decompress" wording is
**deferred** (the range-decompress tooling is not ready); only the "when to
decompress" / "what is recoverable" guidance is added now.

## ChangeLog

| Commit | File | Change |
|--------|------|--------|
| (this PR) | `lib/prompts/compress-range.ts` | + `SUMMARY STRUCTURE` section (3 points) after LEAN paragraph |
| (this PR) | `lib/prompts/compress-message.ts` | + `SUMMARY STRUCTURE` section (3 points, message-worded) before MESSAGE IDS |

No tool/schema/state change. No version bump.

## KeyFiles

- `lib/prompts/compress-range.ts` — range-mode compress prompt (editable)
- `lib/prompts/compress-message.ts` — message-mode compress prompt (editable)
- `lib/prompts/extensions/tool.ts` — NON-editable format schema (untouched)

## DesignNotes

The three points map to the failure modes observed in issue #9:

1. **What this range covers** — semantic description, not raw IDs. Fixes
   summaries that were just lists of message IDs.
2. **Critical content, transcribed** — copy the content itself (code, error
   text, exact values), not a pointer to where it lives. Fixes pointer-style
   summaries that lost the actual detail.
3. **What is recoverable, and when** — name the kind of detail trimmed (full
   diffs, long logs, complete reads) and the situations a later step might
   want it back. The model must not invent a block ID (it does not know the
   eventual `bN`); the reader locates blocks via `acp_status` / `search_context`
   when needed.
4. **Why detail was omitted** (added per user follow-up) — when a file, report,
   code, user instruction, or discussion result is not transcribed (or is
   reduced to one line), state why (redundant / dead end / recoverable /
   low-signal). Closes the accountability gap: the reader should never wonder
   why something that looked important was dropped.

**D3 deferral**: the original draft included "do not push the reader to
decompress" to implement decision D3 (don't force decompress). User said to
hold that wording until the range-decompress tool (D4) is ready — only the
"when to decompress" part ships now.

## Testing

- `npm run typecheck` — clean (prompts are string constants; no type surface)
- Build — succeeds (bundle size 351.18 KB)
- `tests/prompts.test.ts` references `compress-message` only in an
  override-preservation test (no content assertions), so the edit is safe

## Risk

Low. Prompt-only change. No persisted-state, schema, or control-flow change.
Worst case: wording does not improve summary quality → iterate on prompt copy.

## Lessons

- Defer tooling-dependent wording until the tool exists. Adding "don't push
  decompress" before range-decompress is ready would advise against behavior the
  tool layer doesn't yet support cleanly.

## Followups

- D4: range-aligned decompress tool (separate PR)
- D3: revisit decompress-nudge wording after D4 lands
- Release: bump version + changelog after observing effect (`看效果`)
