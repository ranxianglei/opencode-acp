# REQ: Release v1.13.1

## Why this release

npm `latest` is stuck at `1.12.10` while master had progressed through `1.13.0` (PR #166 — pluggable quality gate) and now `1.13.1` (merges of PR #167 + PR #168). Neither 1.13.x version was ever published to npm because their PRs merged from non-`release-v*` branches, so the `release.yml` workflow skipped the publish step.

This release back-fills the 1.13 series by publishing master HEAD as **`v1.13.1`**, covering two pieces of work:

1. **PR #167 — compress notification freeze fix** (already had a `release: v1.13.1` commit on its branch, but never reached npm)
2. **PR #168 — cc-alg extraction** (refactor with no version bump on its own branch, merged on top of #167)

## Why 1.13.1 and not 1.14.0

User decision (issue #30): "1.14 直接跨版本不好". The cc-alg extraction adds new files (NOTICE), new API surface (trigger policy registry), and a dependency-path change (`file:` → npm), all of which would normally warrant a minor bump. User preferred sequential versioning without skipping. We honor the existing `1.13.1` already in master's `package.json` rather than rewriting history back to `1.13.0`.

## Scope of this release PR

This PR is **purely release bookkeeping** — no code changes. Contents:

1. **README.md** — update the existing `### v1.13.1` changelog entry to cover both PR #167 (compress fix) and PR #168 (cc-alg extraction), since the original entry only documented the compress fix
2. **README.zh-CN.md** — same update in Chinese
3. **AGENTS.md** — add new Git Safety Rule (§5.1.1.1): "NEVER modify `version` field in `package.json` on non-release branches". Per user request: "禁止不发分支的时候升版本号，就是普通的 PR 禁止改版本号，防止以后再乱改版本号"
4. **devlog/2026-07-20_release-v1.13.1/{REQ,WORKLOG}.md** — this entry

No `package.json` change needed (master already at `1.13.1` from PR #167's release commit `d316cfd`).

## Acceptance criteria

- [x] Branch name matches `YYYY-MM-DD_release-v1.13.1` (required for CI auto-tag)
- [x] `package.json` version is `1.13.1` (inherited from master, no change)
- [x] README.md has `### v1.13.1` changelog entry
- [x] README.zh-CN.md has `### v1.13.1` changelog entry
- [x] devlog/2026-07-20_release-v1.13.1/ has REQ.md + WORKLOG.md
- [x] AGENTS.md §5.1.1.1 includes new rule about version bump discipline
- [x] `scripts/ci/check-pr.sh` passes locally
- [ ] PR merged by human → CI auto-publishes `v1.13.1` to npm latest

## Post-merge expectation

After merge, `release.yml` will:

1. Detect the merge came from `2026-07-20_release-v1.13.1` (matches `YYYY-MM-DD_release-v*` pattern)
2. Read `version: "1.13.1"` from `package.json`
3. Create git tag `v1.13.1`
4. Run `npm ci` → `npm run check:package` → `npm test`
5. Publish `opencode-acp@1.13.1` to npm `latest` tag (no `-` in version → stable, not prerelease)
6. Create GitHub Release `v1.13.1` with auto-generated notes

npm registry state transition: `1.12.10` → `1.13.1` (1.13.0 skipped on npm but exists in git history at commit `155e410`).
