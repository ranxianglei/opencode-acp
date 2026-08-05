# REQ — v1.14.13-dev.1 Dev Prerelease

## Summary

Dev prerelease covering PR #276 (allowSubAgents promotion to top-level config with default `true`).

## Scope

- **PR #276**: Promote `allowSubAgents` from `experimental` to top-level config field. Default changed from `false` to `true`. Backward compatible: old `experimental.allowSubAgents` configs still work.
