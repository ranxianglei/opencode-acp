# REQ: Compression summary format guidance (issue #9)

## Background

Issue #9 (`调查这个压缩失败可能原因`) surfaced that model-written compress
summaries were inconsistent: some were pointer-style ("X is in file Y") rather
than self-contained records, some omitted the kind of detail that got trimmed,
and the model had no guidance on what a good summary *structure* looks like.

The compression quality prompts (`lib/prompts/compress-range.ts`,
`lib/prompts/compress-message.ts`) told the model to be EXHAUSTIVE and LEAN but
did not give it a concrete structure to organize the summary around.

## Requirement

Give the model a summary structure in the two compress prompts so summaries
become self-contained, faithfully preserve critical content, and name what was
trimmed (so a later step knows whether to decompress).

## Design decisions (per user, 2026-07-07)

| # | Question | Decision |
|---|----------|----------|
| D1 | What counts as "critical content"? | **(b)** the model self-judges what is critical; no hardcoded category list |
| D2 | Structure enforcement | **(a)** sections *inside* a single summary string — no schema/tool change |
| D3 | Push decompress? | **Deferred** — do NOT add "do not push the reader to decompress" wording yet (the range-decompress tooling is not ready; revisit after D4) |
| D4 | Range-aligned decompress tool | **Follow-up PR** (tool-layer change) — out of scope here |
| D5 | Rollout | **Prompt wording first** (`看效果`), then decide on a release |

Core philosophy (user): the structure is **not mandatory**. The model omits any
point with no content. Do NOT fabricate to fill the template
("要求强制，他没有就瞎造，最后乱七八糟").

## Acceptance criteria

- [x] Both compress prompts (range + message) gain a `SUMMARY STRUCTURE` section
- [x] Four points: (1) what this range/message covers, (2) critical content
      transcribed verbatim, (3) what is recoverable + when, (4) why detail was
      omitted (justification for anything not transcribed in detail)
- [x] Wording states the structure is not mandatory and empty points are omitted
- [x] No `do not push the reader to decompress` sentence (D3 deferred)
- [x] No tool/schema change (D2 = wording only)
- [x] `npm run typecheck` clean
- [x] Build succeeds

## Constraints

- Backward compatibility: no persisted-state or tool-schema change
- Editable prompts only (`compress-range.ts`, `compress-message.ts`) — the
  non-editable format schema in `lib/prompts/extensions/tool.ts` is untouched
- No version bump this PR — release later after observing the effect

## Out of scope

- D4: range-aligned decompress tool (separate PR)
- D3 decompress-nudge wording (revisit after D4 lands)
