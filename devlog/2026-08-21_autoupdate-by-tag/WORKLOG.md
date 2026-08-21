# WORKLOG — Auto-Update Tracks Installed Dist-Tag

## Changes

- `lib/update.ts`
  - `checkAutoUpdate`: resolves install spec via new `updateTarget`, maps it to a dist-tag via
    new `specUpdateTag`, fetches that tag's current version.
  - `updateTarget` (new export): `{removeDir, spec}`; `updateRemoveDir` kept as thin wrapper
    (existing public API/tests unchanged).
  - `isAutoUpdatableSpec`: now accepts registry dist-tag words (`stable`, `dev`, `pr-327`, …).
  - `isDistTag` (new): charset `[A-Za-z0-9._-]`, no leading punctuation; rejects exact semver
    pins (`parseVersion`) and x-ranges (`1.x`).
  - `specUpdateTag` (new export): tag word → itself; `*`/range → `latest`; otherwise `undefined`.
  - `fetchLatestVersion(name, tag, signal)`: `/name/<tag>` instead of hardcoded `/latest`.
- `tests/update.test.ts`: +5 tests (dist-tag acceptance, pin/git/file rejection, tag mapping,
  `opencode-acp@stable` README layout now updatable, `updateTarget` spec exposure). TDD order:
  new tests failed on pre-fix code (`isAutoUpdatableSpec("stable") === false` verified), then
  pass after fix.
- `README.md` / `README.zh-CN.md` / `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`: autoUpdate
  documented as tag-tracking.

## Root-cause evidence

- opencode v1.18.20 `packages/core/src/npm.ts`: `directory(pkg) = path.join(global.cache,
  "packages", sanitize(pkg))` — wrapper dir named after the user spec; `savePrefix: ""` pins
  exact versions in wrapper `package.json`; existing `node_modules/<name>` short-circuits
  re-reify, so ACP's rm-wrapper self-update is the only refresh path.
- `https://registry.npmjs.org/-/package/opencode-acp/dist-tags`: `latest` 1.14.22, `stable`
  1.14.19, `dev`, 25 `pr-*` tags.
- `GET /opencode-acp/stable` → version 1.14.19; `GET /opencode-acp/pr-327` → 1.14.22-pr.327.46
  (dist-tag resolution on the version endpoint confirmed).

## Verification

- `node --import tsx --test tests/update.test.ts`: 10/10 pass (was 5/5 before, new 5 fail-first)
- `npx tsc --noEmit`: 0 errors
- Full suite: 1015 pass / 0 fail (1010 master baseline + 5 new)
