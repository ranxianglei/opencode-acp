# REQ — v1.14.19: Fix release pipeline for real (npm 10 `--ignore-scripts` bug)

## Problem

v1.14.18 (PR #306) was merged but never published — `release.yml` failed at the exact same `verify-package.mjs` step as v1.14.17. The v1.14.18 fix (`npm pack --ignore-scripts`) turned out to be insufficient: the CI runner uses Node 22 (npm 10.9.x), and **npm 10 runs the `prepare` lifecycle hook during `npm pack` even when `--ignore-scripts` is passed**. The flag works on npm 11 (local Node 25), which is why local verification passed but CI failed. When prepare runs, tsup writes `CLI Building entry: index.ts` to **stdout**, breaking `JSON.parse` in `verify-package.mjs`.

Two consecutive versions (1.14.17, 1.14.18) failed to publish because of this.

## Fix

Redirect the `prepare` build's stdout to stderr: `"prepare": "npm run build 1>&2"` in `package.json`.

- Build output (informational) goes to stderr
- stdout stays pure JSON regardless of npm version or whether `--ignore-scripts` works
- Verified empirically with npm 10.9.9 locally: `npm pack --dry-run --json` returns valid JSON (173 tarball entries) both with and without `--ignore-scripts`
- The `--ignore-scripts` flag added in v1.14.18 is kept (harmless on npm 10, skips redundant rebuild on npm 11)
- The `npm install github:...#branch` path still works — prepare still runs and still builds `dist/`

## Acceptance

- `npm run check:package` green on both npm 10.9.9 and npm 11.12.1
- release.yml publishes v1.14.19 to npm `latest` after merge
