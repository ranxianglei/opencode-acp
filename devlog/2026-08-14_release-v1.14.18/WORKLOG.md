# WORKLOG — v1.14.18: Supersedes unpublished v1.14.17 (fix release pipeline)

## Investigation

- Merged #305 triggered `release.yml`; the `publish` job failed at
  `npm run check:package`:
  `SyntaxError: Unexpected token 'C', "CLI Building..." is not valid JSON`
  at `validatePackedFiles` (scripts/verify-package.mjs:207), Node v22.23.2
  on CI — reproduces locally too.
- Chain: #298 added `"prepare": "npm run build"` to package.json →
  `verify:package` runs `npm pack --dry-run --json` → npm executes
  `prepare` during pack → tsup prints `CLI Building entry: index.ts` to
  stdout → `JSON.parse(output)` fails.
- Confirmed `pr-artifact.yml` already publishes with `--ignore-scripts`
  for the same reason; `check:package` builds `dist/` before
  `verify:package` runs, so skipping scripts during pack does not change
  what is packed.

## Change

- `scripts/verify-package.mjs`: `npm pack --dry-run --json` →
  `npm pack --dry-run --json --ignore-scripts` (+ comment documenting why).
- Release files: package.json 1.14.18, bilingual changelog entries, this
  devlog pair.

## Verification

- `npm run verify:package`: passed (`tarball entries: 173`).
- `npm run check:package`: green (previously failing).
- `npm test`: 976 pass / 0 fail.
- `./scripts/ci/check-pr.sh 2026-08-14_release-v1.14.18 github/master`: all
  checks passed.

## Release

- Commit `release: v1.14.18 — fix release pipeline (supersedes unpublished v1.14.17)`.
- Human merges → release.yml (squash-merge Pattern 2) → tag `v1.14.18` →
  npm `latest` → GitHub Release.
- v1.14.17 remains a changelog entry only; it was never published to npm.
