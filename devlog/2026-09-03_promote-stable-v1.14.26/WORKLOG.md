# WORKLOG — Promote v1.14.26 to stable

## Steps

1. Verified v1.14.26 published to npm `latest`: `npm view opencode-acp dist-tags` → `latest: 1.14.26`, published 2026-08-29T05:53:00Z (PR #353 merged)
2. Verified current `stable` pointer is stale: `npm view opencode-acp dist-tags.stable` → `1.14.19` (7 versions behind)
3. Verified master HEAD `ba5ef36` = origin/master; diff vs tag `v1.14.26` is PR #352 only (soft deprecation docs + 11 lines `lib/config.ts`, no behavior change) — no new release number needed
4. Created branch `2026-09-03_promote-stable-v1.14.26` from master `ba5ef36`
5. No code/config changes — promote-only PR (devlog only), per the established pattern of PRs #270/#273/#283/#309

## Verification

- `./scripts/ci/check-pr.sh 2026-09-03_promote-stable-v1.14.26 origin/master` — branch name, devlog REQ/WORKLOG present, version unchanged (changelog check skipped)

## After merge

release.yml Pattern 3 (squash title `promote: stable v1.14.26 — ...`) or Pattern 4 (standard merge of branch `..._promote-stable-v1.14.26`) runs `npm dist-tag add opencode-acp@1.14.26 stable`. Verify with `npm view opencode-acp dist-tags` → `stable: 1.14.26`.
