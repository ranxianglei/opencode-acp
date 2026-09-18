# WORKLOG - Align nudge/system prompt discipline with billion-context-pi

- Task ID: `2026-09-18_nudge-prompt-align-bcp`
- Branch: `2026-09-18_nudge-prompt-align-bcp` (from `master` @ 06efd39c)
- Date: 2026-09-18
- Status: Done (pending dual-agent review + human merge)
- Issue: https://github.com/ranxianglei/opencode-acp/issues/436

## Changes

Prompt-only alignment with the pi-side (bcp 0.1.71 / acp-kernel 0.0.69) discipline: listed candidates are authoritative at nudge build time; `acp_status` is no longer recommended as a pre-check before compressing. It remains an optional diagnostic/refresh path and is mandated only for failure recovery (re-issue in the same turn using only reported refs). No arming/state/tool-behavior changes were needed: opencode-acp already validates candidates against the real range executor at nudge construction (`planCompressionCandidates()` → `prepareExecutableRangePlans()`, `lib/messages/inject/candidates.ts`), which is stronger than the kernel's static suggestions.

| File | Change |
|------|--------|
| `lib/prompts/context-limit-nudge.ts` | CANDIDATE_GUIDANCE: "Use `acp_status` for a fresh candidate view if the list is stale or missing." → candidates validated at nudge build time, compress directly, post-failure recovery wording. |
| `lib/prompts/system.ts` | (a) COMPRESSION CANDIDATES bullet: validated-at-build-time + "do not call `acp_status` first"; (b) new failure-recovery bullet under COMPRESSION SUMMARIES IN CONTEXT (no arithmetic range adjustment; re-issue same turn from reported refs, batched); (c) deleted MULTI-TIER "call `acp_status` first" paragraph. |
| `lib/prompts/compress-range.ts` | CANDIDATE GUIDANCE tail: removed "use `acp_status` when the candidate list is stale"; added direct-action + post-failure recovery sentence. |
| `tests/prompts.test.ts` | +2 regression tests pinning new system-prompt wording and asserting removal of old hedging phrases. |
| `tests/nudge-text.test.ts` | +2 constant-level tests: CANDIDATE_GUIDANCE direct-action wording; range-mode prompt (candidates on) free of pre-check hedging, legacy off-mode unaffected. |
| `tests/compression-candidates.test.ts` | +`renderedNudgeText` helper and multi-turn test (AGENTS.md §5.7.1): two consecutive `injectCompressNudges` calls sharing one SessionState, asserts `shouldInjectThisTurn`, `lastPerMessageNudgeTokens` (unchanged baseline) and `lastNudgeShownTokens` after each turn, rendered nudge carries the new guidance without old hedging, production-style `preserveRecentMessages: 20`. |

Not ported verbatim from the kernel: "Every successful compress renumbers the remaining refs" — opencode-acp refs are sticky per raw message ID (`lib/message-ids.ts` keeps existing refs), so the recovery line is phrased generically ("fails because a ref is stale or unknown").

## Verification

- `npm run typecheck` — pass.
- `npx prettier --check` on all 6 changed files — pass (repo-wide `format:check` reports pre-existing violations in unrelated files at HEAD as well).
- `npm run build` (tsup + tsc declarations) — pass.
- Full suite `node --import tsx --test tests/*.test.ts`: **1270/1272 pass**. Both failures are environmental in this sandbox (read-only `/tmp`) and reproduce independently of this diff:
  - `tests/soft-block.test.ts:14` — top-level `mkdirSync('/tmp/opencode-dcp-dangerous-*')` → EACCES.
  - `tests/inactive-block-decompress.test.ts:206` — E2E writes `toFile` output to hardcoded `/tmp/test-inactive-block-decompress.txt`, rejected by the decompress path policy (workspace `.tmp` or `~/.cache/opencode`).
- Touched files in isolation: 35/35 pass (`prompts`, `nudge-text`, `compression-candidates`).
- New multi-turn test verified to exercise the max-limit anchor path: with `maxContextLimit: 1399` between turn-1 usage (100) and turn-2 usage (1400), `contextLimitAnchors` arms on turn 2 and CANDIDATE_GUIDANCE renders into the suffix message.

## Lessons Learned

- The Edit tool can fuzzy-match into a near-identical sibling block (two `config({...})` literals sharing most fields); after any edit into a file with repeated similar blocks, verify the landing site (grep/read) before running. One misfired sequence left a duplicated fragment in the file; recovered by restoring from HEAD and re-appending the appended-only tail, keeping the diff pure additions (+70 lines in that file).
- Nudge internals confirmed while building the multi-turn test: numeric `maxContextLimit`/`minContextLimit` are absolute tokens; `overMaxLimit` is strict `>`; `contextLimitAnchors` populate only when over max (cleared otherwise and after a processed compress); `injectCompressNudges` deliberately does NOT update `lastPerMessageNudgeTokens` (#207 baseline-reset guard) — baseline assertions must account for `setup()` initialization.
- In this sandbox `/tmp` is read-only: temporary artifacts go under `$TMPDIR` (workspace `.tmp/`). Two pre-existing tests assume writable `/tmp` and fail here (reported in issue thread; not fixed in this PR to keep the diff scoped).

## Follow-ups (human decision)

- Dual-agent review of `lib/` + test changes per AGENTS.md §5.3/§5.6, then human merge.
- Optional separate issue (owner-initiated): make the two `/tmp`-dependent tests sandbox-portable.
