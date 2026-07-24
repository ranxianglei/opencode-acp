# WORKLOG: Release v1.13.4

## Steps

1. Created release branch `2026-07-25_release-v1.13.4` from merged master (89e427e)
2. Bumped version: 1.13.3 → 1.13.4 in `package.json`
3. Added changelog entries to `README.md` and `README.zh-CN.md`
4. Created devlog entry
5. Verified: typecheck + test + build

## CI flow on merge

1. Push to master → `release.yml` detects release branch merge
2. Creates `v1.13.4` tag
3. Runs `npm ci` → `npm run check:package` → `npm test`
4. Publishes to npm with `--tag latest`
5. Creates GitHub Release
