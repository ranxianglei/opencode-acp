# REQ: README sync + release-prep fixes (post three-PR merge)

- Task ID: `2026-06-27_readme-release-prep`
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: Done
- Priority: P1
- Owner: awork (glm-5.2)
- References: dog/opencode-acp#3; follows merges of PR #13 (mark_block), #16 (title-gen-skip, Bug 37), #17 (compress-summary-role, Bug 36)

## 1. Background & Problem Statement

After merging PR #13/#16/#17 into master, the repository was in a state that blocked a clean 1.4.0 release:

- **README badly out of date**: still claimed "35 bug fixes" (now 37), documented no `mark_block`/`unmark_block` tools, no `gc.batchCleanup` config, an incomplete default protected-tools list, and a DCP comparison table that undersold ACP's capability lead (model-driven decompress + block cleanup are not mentioned at all). The `$schema` URL pointed at the old DCP repo.
- **Typecheck-breaking duplicate import**: `lib/hooks.ts` had two identical `import { getLastUserMessage } from "./messages/query"` lines (one from PR #13, one from PR #16) that git auto-merge kept both of → `tsc` reports TS2300 duplicate identifier. This is a hard gate for `npm run check:package`.
- **Stale schema URLs**: `lib/config.ts` (default config written to users) and `dcp.schema.json` `$id` both pointed at `Opencode-DCP/opencode-dynamic-context-pruning` instead of the ACP repo.

## 2. Acceptance Criteria

- [x] README (EN + ZH) reflects 37 bug fixes, documents `mark_block`/`unmark_block`, shows `gc.batchCleanup` in default config, lists the full default protected-tools set, and the DCP comparison table highlights model-driven decompress + block cleanup + pressure-aware GC.
- [x] `lib/hooks.ts` has exactly one `getLastUserMessage` import → `npm run typecheck` clean.
- [x] `$schema` / `$id` URLs in `lib/config.ts`, `dcp.schema.json`, and both READMEs point at `ranxianglei/opencode-acp`.
- [x] `npm run typecheck`, `npm run build`, full test suite all pass.
- [x] Version number left at 1.3.1 (the 1.4.0 bump + tag + publish happens in a separate post-merge release commit).

## 3. Non-Goals

- No version bump in this PR (reserved for the release commit after merge).
- No behavioral logic changes — the only `lib/` edits are the duplicate-import dedup and the schema URL string.
