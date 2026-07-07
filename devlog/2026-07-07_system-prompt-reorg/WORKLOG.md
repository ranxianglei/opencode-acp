# WORKLOG — System prompt four-part reorg (issue #9)

## Summary

Reorganized `lib/prompts/system.ts` from a flat section list into a coherent WHAT → WHEN → HOW → FEEDBACK flow, and consolidated the previously-scattered "what to preserve" guidance into a single authoritative paragraph inside the new HOW TO COMPRESS section. Pure text reorganization — no code logic, config, or schema changes. The goal is to fix the root cause of malformed compress summaries identified in issue #9: the system prompt (the model's per-turn behavior spec) described tools and *when* to compress but never *how*, and the one place that tried to describe format sat in the wrong position with its guidance fragmented across three other sections.

## ChangeLog

| Commit | Description |
|--------|-------------|
| (this branch HEAD) | feat: reorganize system prompt into WHAT→WHEN→HOW→FEEDBACK, consolidate preserve-hints into HOW TO COMPRESS |

## KeyFiles

- `lib/prompts/system.ts` — the only source file changed. Section order before → after:
  - Before: Intro, ACP TAGS, TOOLS, **SUMMARY STRUCTURE**, COMPRESSION PHILOSOPHY, BE FRUGAL, WHEN TO COMPRESS, WHEN NOT TO COMPRESS, PERIODIC CONTEXT STATUS, CONTEXT BREAKDOWN.
  - After: Intro, ACP TAGS, TOOLS, **WHEN TO COMPRESS** (absorbs COMPRESSION PHILOSOPHY + BE FRUGAL + the trigger list), WHEN NOT TO COMPRESS, **HOW TO COMPRESS** (relocated + renamed SUMMARY STRUCTURE, with unified must-preserve paragraph), PERIODIC CONTEXT STATUS, CONTEXT BREAKDOWN.
- `devlog/2026-07-07_system-prompt-reorg/REQ.md` + `WORKLOG.md` — this devlog.

## DesignNotes

### Why reorganize, not extend

The system prompt is injected every turn at the very front of context — it is the model's *code of conduct* for compression. PR #65 added a `SUMMARY STRUCTURE` section to describe summary format, but placed it *before* the WHEN sections and left the "preserve what" guidance scattered across four locations. Adding more text on top of an incoherent structure would deepen the problem. The user's directive (issue #9) was to make the prompt logically harmonious first: *what* the tools are → *when* to compress → *how* to compress → *how to read runtime feedback*.

### The must-preserve consolidation

Three WHEN-TO bullets previously embedded preserve-hints inline:
- bullet 3: "…preserve the lessons learned: what was tried, what failed, and why."
- bullet 5: "…preserve the decision rationale if it will be referenced later."
- bullet 7: "…preserving what endures: key findings, relevant code and file paths, decision rationale, and lessons learned…"

These were trimmed to their trigger wording and the preserve-guidance consolidated into one paragraph inside HOW TO COMPRESS:

> Regardless of structure, every summary must also preserve (drawn from the range's actual content, never from pointers): the lessons learned — what was tried, what failed, and why; the decisions and their rationale, when they will be referenced later; and what endures from the range — key findings, relevant code and file paths, and what is worth remembering next time.

No information is lost — the three trimmed clauses are now stated authoritatively in one place.

### Empty-backtick placeholders

`lib/prompts/system.ts` contains two render-time template slots written as `` `` `` (empty backtick pairs) — at the ACP TAGS sentence and at the CONTEXT BREAKDOWN footer. These are replaced with actual tag names (`<acp-context>`, `<dcp-message-id>`, `<dcp-system-reminder>`, `<acp-compression-summary>`) when `prompts/index.ts` renders the prompt. They were preserved verbatim; verified with `grep -n '^\`\`'`.

### No umbrella headers

The four-part structure (WHAT / WHEN / HOW / FEEDBACK) is realized by *ordering* the existing section headers, not by inserting new umbrella headers. This keeps the diff small and reviewable — it is visibly a relocation + one added paragraph, not a rewrite.

## Testing

- `npm run typecheck` — exit 0.
- `npm run build` — exit 0; `dist/index.js` = 350.19 KB (was 349.13 KB; +1.06 KB from the added must-preserve paragraph and the consolidated wording).
- Bundle content verified: `grep -c 'HOW TO COMPRESS' dist/index.js` = 1; `grep -c 'Regardless of structure' dist/index.js` = 1.
- No unit tests directly assert on the system prompt body (it is a plain string export consumed by `prompts/index.ts`); correctness is verified by typecheck + build + manual review of the diff.

## Risk

- **Behavioral**: this is the highest-impact prompt in the plugin (injected every turn). A reorganization changes the order in which the model reads the guidance. The risk is that moving HOW *after* WHEN could, in theory, slightly delay format guidance until after the model has decided to compress. Mitigation: the format detail is also restated in the `compress` tool description (seen at tool-call time), so the system-prompt HOW section is reinforcement, not the sole source. The expected net effect is positive (coherent flow) but should be validated empirically before/after merge.
- **No logic risk**: no code path, config, schema, or persisted-state format changes. Rollback is a single-file revert.
- **Deploy deferred per user instruction**: not installed locally; review-only until the user approves.

## Lessons

- When adding a new section to a per-turn system prompt, place it in logical reading order, not at the insertion point of least resistance. PR #65 placed SUMMARY STRUCTURE at L18 (just after TOOLS) because that was the natural "describe the tool, then describe its output" spot — but logically it belongs after the model knows *when* to act.
- Scattered guidance is worse than consolidated guidance. Four places saying "preserve X" is weaker than one authoritative paragraph, because the model weights a single clear statement higher than four scattered hints.
- For the highest-impact prompts, prefer a pure reorganization PR (small, reviewable, revertable) over a rewrite. The user explicitly asked for review-before-install on this one.

## Followups

- **Review then deploy**: user will review the PR; on approval, deploy via `./scripts/dev-deploy.sh` and validate against a real session with many old-style summaries (the few-shot interference case from issue #9).
- **Empirical validation**: after deploy, observe whether new summaries conform to the 4-point structure better than the PR #65 baseline. If few-shot interference still dominates, the mechanism-design options (M5a deterministic recoverability generation) remain on the table as the next phase.
- **Optional**: consider whether the must-preserve paragraph should also be reflected in the message-mode and range-mode compress prompts (`lib/prompts/compress-message.ts`, `lib/prompts/compress-range.ts`) for symmetry — currently those describe the EXHAUSTIVE / USER-INTENT-FIDELITY / LEAN qualities but not the explicit must-preserve list.
