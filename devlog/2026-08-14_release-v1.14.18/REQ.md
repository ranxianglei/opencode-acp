# REQ — v1.14.18: Supersedes unpublished v1.14.17 (fix release pipeline)

## Background

- v1.14.17 was merged to master via #305 (squash commit `2616f62`) but
  `release.yml` FAILED and never published: `npm run check:package` crashed
  in `scripts/verify-package.mjs` `validatePackedFiles` with
  `SyntaxError: Unexpected token 'C', "CLI Building..." is not valid JSON`.
- Root cause: #298 added `"prepare": "npm run build"` to package.json (so
  GitHub-branch installs auto-build). `verify:package` shells out to
  `npm pack --dry-run --json`; npm runs `prepare` during pack, tsup writes
  `CLI Building entry: index.ts` to stdout, and `JSON.parse(output)` fails.
- npm `latest` is still 1.14.16; tag/release v1.14.17 do not exist.

## Requirement

1. Fix `verify-package.mjs` to tolerate the `prepare` hook: use
   `npm pack --dry-run --json --ignore-scripts` (consistent with
   `pr-artifact.yml`, which already publishes with `--ignore-scripts`;
   `dist/` is already built by `check:package`'s build step).
2. Cut a stable release per AGENTS.md §5.4.2 from master with the fix:
   version 1.14.18 supersedes never-published 1.14.17.

## Acceptance criteria

- `npm run check:package` green locally (previously failing).
- `./scripts/ci/check-pr.sh 2026-08-14_release-v1.14.18 github/master` passes.
- Merge triggers release.yml → tag v1.14.18 → npm `latest` → GitHub Release.
