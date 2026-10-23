# WORKLOG - Release v1.18.3

## Steps

1. One-click release workflow (`release-manual.yml`, triggered 2026-09-30) resolved version 1.18.3, passed drift guard + pre-flight gate, and committed the bump. Direct push to master was blocked by branch protection → fallback branch `2026-09-30_release-v1.18.3` pushed, PR #475 opened automatically.
2. Review of PR #475 ran `./scripts/ci/check-pr.sh 2026-09-30_release-v1.18.3 origin/master` locally: **3 failures** — missing `devlog/2026-09-30_release-v1.18.3/{REQ,WORKLOG}.md` and no CHANGELOG update. Root cause: the one-click workflow only bumps `package.json` + `package-lock.json` (its "Verify bump diff" step enforces exactly those two files) and generates neither devlog nor changelog, although its step summary claims "with the generated changelog". This is the first release to reach the fallback path, so the gap surfaced now. The workflow defect is tracked in a separate issue with a 来源 marker pointing at #475.
3. Fix-up commit on the release branch: this devlog folder + `### v1.18.3` entries in both changelogs. No code touched.
4. Version-range regression audit (v1.18.2..HEAD, 19 non-merge commits) completed during PR #475 review — see "Audit" below.
5. Pushed fix-up to the PR branch; `pr-validation` re-runs and must pass. Human merges → `release.yml` auto-publishes.

## Audit (v1.18.2 → v1.18.3, from PR #475 review)

Per-change regression verdicts — existing behavior of each touched path inventoried before judging:

| Change | Verdict |
|--------|---------|
| #405 bili native yield | Intended behavior change (old: yield only on `BILLION_CONTEXT_PROXY` sampled once at setup + `/bili/` baseURL detection; new: also yields on `BILLION_CONTEXT_NATIVE`, re-sampled at every hook call / config run / tool action). No collateral regressions: yield paths skip `hostPermissions.global` assignment exactly as the old proxy path did; false positives limited to the two dedicated env vars; all five tools gated at `resolveToolContext`. Tests: `tests/bili-native-yield.test.ts` (+355). |
| #446 decompress source availability | Intended fail-closed change (old: phantom "restored N" claims + stats underflow + irreversible summary discard when originals absent; new: explicit abort, zero state mutation). Check precedes all mutations; `toFile` path unaffected (no state change; falls back to annotated summary export). Conservative direction verified: over-requiring IDs ⇒ safe-direction abort only. Tests: +426/+248 lines. |
| #447 toFile originals | Intended output-format fix (old format was broken — read non-existent `content`/`text` fields off SDK messages, exported JSON garbage; new: parts serialization, text verbatim + `[tool] output`). |
| #444 quality rejection concise | Intended output-format change (model-facing error shrunk to core reason + 1 stats line + retry hint; full metrics → `logger.warn`). Single call site (`lib/compress/range.ts:323`) passes the logger; `acknowledgeRisk` hint retained. |
| #457/#465 acp_status respect | Intended semantics restoration (user exact/wildcard decisions on `acp_status` no longer inverted/erased by ACP's default write). Preserved: explicit-user-`compress` deferral returns the map unchanged — identical to old behavior; unrelated host rules untouched. Tests: `tests/host-permissions.test.ts` (+102, issue-numbered regression tests). |
| #461 overhead set bound | No behavior change except the leak fix (dedup semantics kept; worst case one duplicate ERROR line after eviction past cap 1024). Test: +73 lines. |
| #443/#474 one-click release CI | `workflow_dispatch`-only, no runtime impact. Contains the devlog/changelog gap found in step 2 above (separate issue filed). |
| Docs (#441/#442/#450/#451/#471) | Cosmetic; no runtime impact (README Community/QQ groups + V2 pointer, AGENTS.md codification, devlogs). |

**Regressions introduced in this version: none.** Major intended behavior changes listed above (all disclosed old→new).

## Known operational notes

- Merge method matters: `release.yml` detects release merges by commit title. Standard merge ("Merge pull request #475 from ranxianglei/2026-09-30_release-v1.18.3") matches Pattern 1 ✓. A squash merge titled "release v1.18.3 (#475)" would NOT match Pattern 2 (`^release: v...` requires the colon) and publishing would be silently skipped — use the standard Merge button.
- Workflow defect (fallback PRs always lack devlog/changelog) tracked in a separate issue with 来源 marker pointing here.

## Post-merge (human merge + automated CI)

- Human merges the PR → `release.yml` detects release branch → tags `v1.18.3` → `npm ci` → `check:package` → full test → publishes to npm `latest` → creates GitHub Release.
- Verify after publish: `npm view opencode-acp dist-tags.latest` = 1.18.3; `gh release view v1.18.3`.
