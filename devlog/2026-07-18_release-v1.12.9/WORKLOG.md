# WORKLOG: Release v1.12.9 — Compress-as-Anchor

## 2026-07-18

### Branch
- Created `2026-07-18_release-v1.12.9` from `github/master` @ `419f506` (Merge PR #153)

### Content (1 PR)
**PR #153 — Compress-as-Anchor**: Removed synthetic recap injection. Compression summaries now live inside `compress` tool calls (the model's own past calls) as anchors. `acp_context_recap` tool becomes manual-only. Updated system prompt + tool descriptions. ~50% reduction in summary overhead for compression-heavy sessions.

### Artifacts
- `package.json`: version bumped to `1.12.9`
- `README.md`: v1.12.9 changelog entry added
- `README.zh-CN.md`: v1.12.9 changelog entry added
- devlog created

### Verification
- typecheck: 0 errors
- tests: 725/725 pass
- build: succeeds
