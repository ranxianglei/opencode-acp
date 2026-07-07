# REQ: dev-deploy.sh dual-path sync (legacy resolution path)

## Background

While testing PR #63 locally, a long-running session showed that compress
summaries did not pick up new prompt changes. Root cause:
`scripts/dev-deploy.sh` deploys to **one** path only:

```
~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/
```

But a second, stale install existed at the legacy resolution path:

```
~/.cache/opencode/node_modules/opencode-acp/
```

The legacy bundle was from Jul 2 with **none** of the recent features
(PR #57/#58/#60/#63 all 0 matches by grep). Depending on opencode version,
the running process may resolve `opencode-acp@latest` to the legacy path, so
deploys to the primary path silently had no effect.

## Requirement

`dev-deploy.sh` must keep both resolution paths in sync so a deploy takes
effect regardless of which path the running opencode loads.

## Acceptance criteria

- [x] Script defines a `LEGACY_TARGET` for the `~/.cache/opencode/node_modules/opencode-acp/` path
- [x] After the primary deploy + version verify, if the legacy path exists, dist + package.json are copied there too
- [x] Legacy sync is logged (`info "Legacy path also synced: ..."`)
- [x] If legacy path doesn't exist, a skip message is logged (no error)
- [x] `bash -n` syntax check passes
- [x] Running the script produces md5-identical bundles at both paths

## Constraints

- No behavior change when the legacy path is absent (fresh machines are unaffected)
- Primary path remains the source of truth; legacy is best-effort sync
