# WORKLOG - README sync + release-prep fixes

- Task ID: `2026-06-27_readme-release-prep`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-06-27

## 1. Summary

- **What was done**: Brought README (EN + ZH) in line with master after the three-PR merge, fixed the duplicate-import typecheck blocker introduced by merging PR #13 + #16, and corrected stale `$schema`/`$id` URLs that pointed at the old DCP repo.
- **Why**: Master had drifted from its docs (37 bugs vs documented 35, unmentioned mark_block feature, incomplete config example), and carried a typecheck-breaking duplicate import that would have blocked `npm run check:package` at release time.
- **Behavior / compatibility changes**: None for runtime logic. The only `lib/` edits are removing one duplicate import line and changing a schema URL string. Users' auto-written default config will now reference the ACP repo schema URL instead of the dead DCP one.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `README.md` / `README.zh-CN.md`
  - "Why ACP": 35 → 37 bug fixes; rewrote the DCP comparison table from 5 rows to 13, highlighting model-driven `decompress`, model-driven `mark_block`/`unmark_block` cleanup, pressure-aware GC, two compression modes, protected-content injection, cache-awareness, auto strategies, and 3-layer config.
  - Added a new "Deferred Block Cleanup (mark_block)" subsection under "How It Works".
  - Default Configuration: fixed `$schema` URL; added the full `gc` section with `batchCleanup` thresholds.
  - Protected Tools: added `decompress`, `mark_block`, `unmark_block` to the default list; added `decompress` to `compress.protectedTools` defaults.
  - Bug Fixes table: 35 → 37 total; added Bug 36 (compression summary role confusion) and Bug 37 (title-gen corruption).
- `lib/hooks.ts`
  - Removed the duplicate `import { getLastUserMessage } from "./messages/query"` (line 46). PR #13 and #16 each added this import at different positions; git auto-merge kept both, causing TS2300. Only the import is touched — the single remaining import + `appendToLastTextPart` import are unchanged.
- `lib/config.ts`
  - Default config `$schema` URL: `Opencode-DCP/opencode-dynamic-context-pruning` → `ranxianglei/opencode-acp` (so the URL written to users' config files points at the live schema).
- `dcp.schema.json`
  - `$id`: same URL correction for consistency with `config.ts` and the READMEs.

## 3. Design & Implementation Notes

- **Duplicate import root cause**: PR #16 (title-gen-skip) added the import after `filterMessages` import (line 27); PR #13 (mark_block) added it after `getCurrentTokenUsage` import (line 46). Both lines are byte-identical. Git's merge resolved them as two separate additions (different surrounding context) instead of flagging a conflict, so CI would only catch it at typecheck time.
- **Why the duplicate matters**: `tsc` reports TS2300 "Duplicate identifier 'getLastUserMessage'", which fails `npm run typecheck` and therefore `npm run check:package` — a hard publish gate.
- **Schema URL**: the `dcp.schema.json` filename is intentionally retained for backward compat (AGENTS.md §2.6); only the host repo in the URL changed.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # PASS (was FAIL before the import dedup)
npm run build       # PASS
npm run test        # 407 pass / 0 fail
```

### Results

- typecheck: PASS (clean after dedup)
- build: PASS
- tests: 407/407 pass

## 5. Follow-ups

- After this PR merges: separate release commit bumps `1.3.1 → 1.4.0`, tags `v1.4.0`, and runs `npm publish` per AGENTS.md §5.4.
- The version bump is intentionally NOT in this content PR, to match the "merge then release" workflow.
