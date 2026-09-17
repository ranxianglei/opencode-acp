# WORKLOG — Promote v1.18.1 to stable

## Steps

1. Verified v1.18.1 published to npm `latest`: `npm view opencode-acp dist-tags` → `latest: 1.18.1`, published 2026-09-15T07:13:18Z (PR #401 merged)
2. Verified current `stable` pointer is stale: `npm view opencode-acp dist-tags` → `stable: 1.14.26` (7 releases behind)
3. Verified master HEAD `06efd39c` = origin/master; diff vs tag `v1.18.1` is PR #403 only in code (`lib/protected-patterns.ts` 6 lines + `tests/protected-patterns.test.ts` 104 lines) plus `.github/workflows/publish-stable-from-acp.yml` — no new release number needed for this promotion
4. Created branch `2026-09-17_promote-stable-v1.18.1` from master `06efd39c`
5. No code/config changes — promote-only PR (devlog only), per the established pattern of PRs #270/#273/#283/#309/#358

## Verification

- `./scripts/ci/check-pr.sh 2026-09-17_promote-stable-v1.18.1 origin/master` — all checks passed (branch name, REQ/WORKLOG present, version unchanged → changelog check skipped)
- `npm run typecheck` — clean
- `npm run build` — success (dist/index.js 482.33 KB)
- `npm test` — 1267 tests, **1265 pass, 2 fail**, both environmental artifacts of the agent sandbox (read-only `/tmp` mount, `$TMPDIR` redirected):
  - `tests/soft-block.test.ts:10,14` — hardcodes `mkdirSync('/tmp/opencode-dcp-dangerous-${pid}')` at module load → EACCES here
  - `tests/inactive-block-decompress.test.ts:203,214` — passes hardcoded `toFile: "/tmp/test-inactive-block-decompress.txt"`, rejected by the toFile path guard (allowed roots: `$TMPDIR` / `~/.cache/opencode`)
  - Both pre-exist on master (this branch = master + devlog only, zero source changes); CI runners have writable `/tmp` with `TMPDIR=/tmp` → expected green there (v1.18.1's release.yml ran the full suite successfully before publishing)

## After merge

release.yml Pattern 3 (squash title `promote: stable v1.18.1 — ...`) or Pattern 4 (standard merge of branch `..._promote-stable-v1.18.1`) runs `npm dist-tag add opencode-acp@1.18.1 stable`. Verify with `npm view opencode-acp dist-tags` → `stable: 1.18.1`.
