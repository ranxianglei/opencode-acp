# REQ — Auto-Update Tracks Installed Dist-Tag

## Problem (Issue #328: "auto update by tag not latest")

The README's canonical install is `opencode plugin opencode-acp@stable --global`, which makes
opencode cache the plugin at `~/.cache/opencode/packages/opencode-acp@stable/node_modules/opencode-acp/`
and pin the exact resolved version in the wrapper's `package.json` (Arborist `savePrefix: ""`).

The inherited DCP auto-updater had two defects for that layout:

1. `isAutoUpdatableSpec("stable")` → `false`. Bare dist-tag words (`stable`, `dev`, `pr-N`) match
   none of the allowed forms (`latest`, `*`, `~`/`^`, comparators, ranges), so auto-update
   **silently never fired** for every user following the README.
2. `fetchLatestVersion` hardcoded the `latest` dist-tag. Even if the gate had passed, a `@stable`
   install would be compared against the `latest` track; removing the wrapper makes opencode
   reinstall `@stable`, so the update would never land (and the toast would claim a version the
   user cannot get). The package publishes many dist-tags (`stable`, `dev`, `pr-325`…`pr-327`),
   so the channel must follow the install spec.

## Fix

Auto-update now tracks the dist-tag the user installed from:

- `wrapperSpec` (directory name suffix `name@<spec>`) remains the source of truth for user intent.
- New `isDistTag`: bare word without `/:@` whitespace, not an exact semver pin, not an x-range.
- `isAutoUpdatableSpec` accepts dist-tags; `pr-N` CI preview installs become auto-updatable.
- New `specUpdateTag(spec)`: dist-tag word → that tag; `*`/ranges → `latest`; pins/non-registry →
  `undefined`.
- `fetchLatestVersion(name, tag)` hits `/name/<tag>` (registry resolves dist-tags; verified:
  `/opencode-acp/stable` → 1.14.19, `/opencode-acp/pr-327` → 1.14.22-pr.327.46).
- `updateRemoveDir` refactored to `updateTarget` returning `{removeDir, spec}`; the old export is
  kept as a wrapper for compatibility.

Behavior matrix:

| Install spec        | Gate   | Registry endpoint checked   |
| ------------------- | ------ | --------------------------- |
| `opencode-acp@stable` | ✅   | `/opencode-acp/stable`      |
| `opencode-acp@pr-327` | ✅   | `/opencode-acp/pr-327`      |
| `opencode-acp@latest` | ✅   | `/opencode-acp/latest`      |
| `^1.14.0` / `*`       | ✅   | `/opencode-acp/latest`      |
| `1.14.22` (pin)       | ❌   | —                           |
| `file:` / `github:`   | ❌   | —                           |
| bare name (no tag)    | ❌   | — (opencode pins exact deps) |
