# WORKLOG - Release v1.14.25

- Task ID: `2026-08-24_release-v1.14.25`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-24 10:00

## 1. Summary

- **What was done**: version bump 1.14.24 → 1.14.25, bilingual CHANGELOG entries, devlog, single `release:` commit on `2026-08-24_release-v1.14.25`.
- **Why**: ship #335 (self-disable under `BILLION_CONTEXT_PROXY`) to the `latest` dist-tag so `opencode-acp@latest` stops double-registering ACP tools against the bili proxy.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| this branch, tip | `release: v1.14.25 — self-disable under billion-context proxy (#335)` |

### Key Files

- `package.json` / `package-lock.json` — 1.14.24 → 1.14.25
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` — v1.14.25 entry (problem/fix/install)
- `devlog/2026-08-24_release-v1.14.25/` — this devlog

## 4. Testing & Verification

```sh
npm run build
npx tsc --noEmit
node --import tsx --test tests/*.test.ts
```

All green locally before pushing. CI (build / test 22+24 / e2e / pr-validation / build-artifact) expected green on the PR; release.yml publishes on merge (branch `*_release-v*` + merge-commit pattern).

## 5. Rollback Plan

- Revert the merge; npm unpublish within 72h if a bad publish lands (last resort).

## 6. Lessons Learned

- This repo's check-pr.sh keys devlog dir off the BRANCH NAME and demands CHANGELOG entries in BOTH languages whenever the version moves — remember both or pr-validation fails.
- opencode-acp resolves plugins from `~/.cache/opencode/packages/<pkg>@<tag>/` — after this release, cached patched copies on dev machines will be overwritten on next update (expected; the patches were temporary).
