# WORKLOG: Compress Tool Token Classification Fix

## Branch
`2026-07-18_compress-token-classification` from `github/master` @ `e90e00a`

## Changes

### `lib/messages/inject/utils.ts`
Modified `estimateContextComposition` tool part branch (line 652-677):
- When `toolName === "compress"`, extract `summary` text from `part.state.input.content[].summary`
- Count summary text as `summaryTokens` (was: `toolTokens`)
- Count structural overhead as `toolTokens` (unchanged behavior)
- `toolTypeBreakdown` for `compress` reflects structural overhead only
- Added 3-line comment explaining WHY compress gets special treatment (non-obvious classification rule tied to compress-as-anchor architecture)

### `tests/inject-utils-pure.test.ts`
Added 5 new tests + `mkCompress` helper:
1. `compress tool summary counted in summaryTokens not toolTokens` — core behavior
2. `compress tool structural overhead counted in toolTokens` — split correctness
3. `compress with multiple content entries sums all summaries` — batch compression
4. `compress tool without state.input falls back to toolTokens` — malformed input
5. `non-compress tools unaffected by summary classification` — regression guard

## Verification
- TypeScript: 0 errors
- Tests: 730/730 pass (5 new)
- Build: 397.48 KB
- Node v25.9.0

## Commits
1. `fix: classify compress tool summary content as summaryTokens` — source fix
2. `test: compress token classification coverage` — 5 new tests
3. `docs: devlog for compress token classification` — this file
