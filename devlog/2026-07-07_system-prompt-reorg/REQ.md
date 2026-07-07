# REQ — System prompt four-part reorg (issue #9)

## Background

Investigation of issue #9 ("调查这个压缩失败可能原因") traced the root cause of malformed compress summaries to the **system prompt** (`lib/prompts/system.ts`), not the compression mechanism.

The system prompt is injected **every turn, at the very front** of the context — it functions as the model's *behavior spec* (行为规范). Before this change it described:

- what each tool does and how to call it (TOOLS),
- **when** to compress and when not to (COMPRESSION PHILOSOPHY / BE FRUGAL / WHEN TO / WHEN NOT TO),
- how to read runtime feedback (PERIODIC CONTEXT STATUS / CONTEXT BREAKDOWN).

But it never described **how** to compress — the format and standards a summary must follow. The `SUMMARY STRUCTURE` section added in PR #65 was placed *before* the WHEN sections, producing an inverted flow (how-before-when) and the "what to preserve" guidance was scattered across the SUMMARY STRUCTURE second point and three different WHEN-TO bullets (3, 5, 7), never unified.

## Reproduction

- Read `lib/prompts/system.ts` at master `d08ae01`.
- Observed section order: Intro → ACP TAGS → TOOLS → **SUMMARY STRUCTURE** → COMPRESSION PHILOSOPHY → BE FRUGAL → WHEN TO COMPRESS → WHEN NOT TO COMPRESS → PERIODIC CONTEXT STATUS → CONTEXT BREAKDOWN.
- `SUMMARY STRUCTURE` sits at L18, ahead of all WHEN sections — the reader is told *how* to write a summary before being told *when* to write one.
- "Preserve what" guidance appears in: SUMMARY STRUCTURE point 2, WHEN TO bullet 3 ("preserve the lessons learned…"), bullet 5 ("preserve the decision rationale…"), bullet 7 ("preserving what endures: key findings…"). Four locations, never consolidated.

## Constraints

- **Pure text reorganization** — no code logic changes, no new runtime behavior, no config/schema changes.
- Preserve the empty-backtick template placeholders (`` `` `` at L7 and L84 in the original) **verbatim** — these are render-time slots filled with actual tag names (`<acp-context>`, `<dcp-message-id>`, `<dcp-system-reminder>`, `<acp-compression-summary>`) by `prompts/index.ts`. Filling or mangling them would corrupt the rendered prompt.
- Keep all existing section headers; only reorder and consolidate.
- Must not break typecheck / build.
- Per §5.1.1.1, master is PR-protected — changes land via PR only.
- Per user instruction: **review only, do NOT deploy** (`dev-deploy.sh` not run).

## Acceptance criteria

1. Section order follows WHAT → WHEN → HOW → FEEDBACK:
   - WHAT: Intro, ACP TAGS, TOOLS
   - WHEN: COMPRESSION PHILOSOPHY, BE FRUGAL, WHEN TO COMPRESS, WHEN NOT TO COMPRESS
   - HOW: HOW TO COMPRESS (relocated `SUMMARY STRUCTURE`, renamed, with a unified "must-preserve" paragraph)
   - FEEDBACK: PERIODIC CONTEXT STATUS, CONTEXT BREAKDOWN
2. The "preserve what" guidance that was previously scattered across WHEN-TO bullets 3/5/7 is consolidated into one authoritative paragraph inside HOW TO COMPRESS.
3. WHEN-TO bullets 3/5/7 are trimmed to their trigger wording only (no information loss — the trimmed preserve-clauses now live in HOW).
4. Empty-backtick placeholders preserved verbatim (2 occurrences).
5. `npm run typecheck` passes.
6. `npm run build` passes and the bundle contains `HOW TO COMPRESS` and the must-preserve paragraph.

## Approach

Single-file edit to `lib/prompts/system.ts`:

1. Delete the SUMMARY STRUCTURE block from its L18 position.
2. Insert the renamed HOW TO COMPRESS block after WHEN NOT TO COMPRESS.
3. Inside HOW TO COMPRESS, add a "must-preserve" paragraph that consolidates the preserve-hints previously embedded in WHEN-TO bullets 3, 5, 7.
4. Trim those three bullets to their trigger wording.
5. Leave PERIODIC CONTEXT STATUS and CONTEXT BREAKDOWN untouched, in place.

No other files touched. The change is deliberately small and reviewable because system.ts is the highest-impact prompt in the plugin (injected every turn).
