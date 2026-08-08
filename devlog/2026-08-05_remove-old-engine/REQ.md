# REQ — remove orphaned old engine (dead code)

Issue: dog/opencode-acp#42 (follow-up) · Branch: `2026-08-05_remove-old-engine`
Base: `2026-08-05_acp-kernel` (stacked; retarget to master after PR #274 merges)

## Problem

After the one-shot acp-kernel rewrite (PR #274), the old in-tree compression
engine was left on disk as dead code (unreferenced by `index.ts`, tree-shaken
from `dist/`). @dog directed: **"旧代码可以直接删除 在新分支"** — delete it, on a
new branch.

## Goal

Remove every source file and test that is no longer reachable from `index.ts`,
so the source tree matches what actually ships.

## Acceptance criteria

- `npm run typecheck` — PASS (no dangling imports).
- `npm run build` — PASS; `dist/index.js` byte-identical to pre-deletion (proves
  the removed code was already dead/tree-shaken — zero runtime impact).
- `npm test` — PASS, 0 fail. Remaining tests cover only kernel + shared infra.
- No file reachable from `index.ts` is deleted (verified by transitive
  import-closure trace).

## Scope

Computed via transitive relative-import closure from `index.ts`
(`scripts`-style trace, see WORKLOG). DEAD = unreachable.

- **51 dead source files** removed: `lib/hooks.ts`, `lib/compress-permission.ts`,
  whole `lib/commands/`, `lib/gc/`, `lib/ui/`, `lib/compress/quality-gate/`,
  `lib/messages/filter/`, `lib/messages/inject/`, plus selected files in
  `lib/compress/`, `lib/messages/`, `lib/prompts/`.
- **47 dead test files** removed (those importing any dead module).
- **KEPT** (still reachable): all of `lib/kernel/`, shared infra
  (`config`, `logger`, `token-utils`, `auth`, `update`, `host-permissions`,
  `config-validation`), and selected old modules the kernel adapter / infra
  still import (`lib/messages/{query,shape}.ts`, `lib/prompts/*` except the
  dead extensions, `lib/state/*`, `lib/message-ids.ts`, `lib/protected-patterns.ts`,
  parts of `lib/compress/`).
