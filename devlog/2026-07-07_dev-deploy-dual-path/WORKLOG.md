# WORKLOG: dev-deploy.sh dual-path sync (legacy resolution path)

## Summary

`dev-deploy.sh` now syncs the legacy opencode resolution path
(`~/.cache/opencode/node_modules/opencode-acp/`) in addition to the primary
`packages/@latest` path, so deploys take effect regardless of which path the
running opencode loads. Prevents the silent-no-op that occurred when a stale
legacy install shadowed the primary deploy.

## ChangeLog

| Commit | File | Change |
|--------|------|--------|
| (this PR) | `scripts/dev-deploy.sh` | + `LEGACY_TARGET` var; after primary deploy+verify, copy dist+package.json to legacy path if it exists, log result |

## KeyFiles

- `scripts/dev-deploy.sh` — local dev build+deploy script

## DesignNotes

The legacy path exists on machines that have run older opencode versions. The
script does not create it (fresh machines stay clean); it only syncs if the
directory already exists. The primary path remains authoritative — the legacy
sync is purely defensive against version-dependent resolution differences.

The two comments added (`LEGACY_TARGET` declaration + the sync block) are
necessary: they document a non-obvious gotcha (two resolution paths that differ
by opencode version) that already caused a real incident (stale shadow made
deploys silently ineffective). Without them a future dev would not understand
why the second path is synced.

## Testing

- `bash -n scripts/dev-deploy.sh` — syntax OK
- Ran `./scripts/dev-deploy.sh` end-to-end — primary deployed, legacy synced
  (`info "Legacy path also synced: ..."`), both paths md5-identical
  (`73e3437c196c6247a5ea194b6132c76f`) after the run

## Risk

Low. Best-effort sync guarded by `[[ -d ... ]]`; no-op when legacy path absent.
No change to primary deploy behavior.

## Lessons

- A deploy script that targets one path can be silently defeated by a stale
  install at an alternate resolution path. When a runtime may resolve a package
  to more than one location, the deploy tooling must cover all of them (or
  clean the alternates).

## Followups

- Consider documenting both resolution paths explicitly in AGENTS.md §3.4
  (currently it only calls the legacy path "wrong" — better to acknowledge it
  may be loaded and must be kept in sync).
