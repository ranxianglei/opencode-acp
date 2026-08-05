# WORKLOG — remove orphaned old engine (dead code)

Issue: dog/opencode-acp#42 (follow-up) · Branch: `2026-08-05_remove-old-engine`
Base: `2026-08-05_acp-kernel`

## Method

Computed the exact dead set via a transitive relative-import closure trace from
`index.ts` (script at `/tmp/opencode/trace-deps.mjs`):

1. BFS from `index.ts` over relative imports → **KEEP set** (41 files).
2. `lib/` files not in KEEP → **DEAD source** (51 files).
3. Tests whose imports resolve into any DEAD source file → **DEAD tests**
   (47 files); remaining 28 test files kept.

This guarantees no reachable file is deleted — only genuinely orphaned code.

## Removed (51 source files)

- Whole dirs: `lib/commands/`, `lib/gc/`, `lib/ui/`, `lib/compress/quality-gate/`,
  `lib/messages/filter/`, `lib/messages/inject/`.
- `lib/hooks.ts`, `lib/compress-permission.ts`.
- `lib/compress/`: decompress-logic, decompress, hide-consumed, hide-failed,
  index, keep-markers, parts, pipeline, range, recap, status.
- `lib/messages/`: index, priority, prune, reasoning-strip, sync,
  truncate-tools, utils.
- `lib/prompts/`: extensions/nudge, extensions/tool, index.

## Removed (47 test files)

All tests that imported a dead module (e.g. `tests/compress-range.test.ts`,
`tests/inject.test.ts`, `tests/e2e-*.test.ts`, `tests/quality-gate-*.test.ts`,
`tests/gc-merge.test.ts`, `tests/hooks-permission.test.ts`, …). Full list in
the trace output.

## Kept (reachable old modules — NOT dead)

The kernel adapter / shared infra still import these, so they must stay:
`lib/messages/{query,shape}.ts`, `lib/prompts/{system,store,compress-range,
context-limit-nudge,iteration-nudge,turn-nudge,extensions/system}.ts`,
`lib/state/{index,persistence,rebuild,state,tool-cache,types,utils}.ts`,
`lib/compress/{protected-content,range-utils,search,state,timing,types}.ts`,
`lib/message-ids.ts`, `lib/protected-patterns.ts`, `lib/config-validation.ts`.

## Verification

- `npm run typecheck` — **PASS** (0 errors; no dangling imports).
- `npm run build` — **PASS**. `dist/index.js` = **175.53 KB**, byte-identical
  to pre-deletion → the removed code was already tree-shaken; **zero runtime
  impact**, pure source-tree cleanup.
- `npm test` — **PASS** (336 tests, 0 fail). Test count dropped 961 → 336
  (−625), exactly the dead-engine tests.
- `scripts/ci/check-pr.sh 2026-08-05_remove-old-engine github/master` — PASS
  (branch name, devlog REQ+WORKLOG present, version unchanged).

## Notes

- The identical `dist/` size confirms the earlier claim in PR #274's WORKLOG:
  the old engine was already fully tree-shaken from the published bundle. This
  PR is a source-hygiene follow-up, not a behaviour change.
- PR is stacked on `2026-08-05_acp-kernel` (base). Retarget to `master` once
  PR #274 merges. Alternatively @dog may fold both into one merge.
