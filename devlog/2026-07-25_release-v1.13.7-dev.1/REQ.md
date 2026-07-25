# REQ — v1.13.7-dev.1 Dev Prerelease

## Goal

Publish current master (v1.13.6) as a dev prerelease to advance the npm `dev`
tag, which is stuck at `1.12.10-dev.1` — far behind `latest` (1.13.6).

## Background

The `dev` tag lets early adopters opt into unreleased changes via
`opencode-acp@dev`. It hasn't been updated since `1.12.10-dev.1`, so it's missing
all v1.13.x changes (quality gate, compress protection, CI fixes, force-protect).

## Scope

- Bump `package.json` version to `1.13.7-dev.1` (contains hyphen → CI uses `--tag dev`)
- Add changelog entries to both READMEs
- Create devlog
- No source code changes

## Acceptance Criteria

- [x] Version set to `1.13.7-dev.1`
- [x] Changelog entries added
- [x] Devlog created
- [ ] CI check passes
- [ ] PR created
- [ ] After merge: npm `dev` tag points to `1.13.7-dev.1`
