# REQ: Release v1.14.12

## Goal
Publish stable release v1.14.12 to npm `latest` tag, superseding v1.14.11.

## Scope
1 PR since v1.14.11:
- **#271** — omo-system-reminder filter v1.3.0: strips `<system-reminder>` blocks, preserves user content. Phase 2 keepLastOnly applies actual decision.

## Checklist
- [x] Bump version in `package.json`
- [x] Add changelog to `README.md`
- [x] Add changelog to `README.zh-CN.md`
- [x] Create devlog (REQ.md + WORKLOG.md)
- [ ] Verify CI locally
- [ ] Commit, push, create PR
- [ ] Wait for CI
- [ ] User merges PR
