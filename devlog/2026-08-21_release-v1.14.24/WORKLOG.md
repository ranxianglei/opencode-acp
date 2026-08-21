# WORKLOG — release v1.14.24

1. `git fetch` — PR #332 already merged by owner as `b0eefdd`; master = logging feature incl. clamp fix `bada84f`.
2. Branched `2026-08-21_release-v1.14.24` from `origin/master`; `npm version 1.14.24 --no-git-tag-version` (package.json + lock).
3. CHANGELOG.md / CHANGELOG.zh-CN.md: added `### v1.14.24` entries (EN + zh) summarizing #332 + clamp fix; install line `opencode plugin opencode-acp@latest --global`.
4. Local verify: `npx tsc --noEmit` → 0 errors; `node --import tsx --test tests/*.test.ts` → 1029/1029 pass.
5. Commit `release: v1.14.24 — default-on decision-level logging (#332)`; push; PR to master.
6. CI 6/6 green → merge → release.yml auto-tags v1.14.24, `npm publish --tag latest`, GitHub Release.
7. Verified `npm view opencode-acp dist-tags.latest` = 1.14.24.
