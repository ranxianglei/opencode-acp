# WORKLOG - Add QQ community group to README (EN + ZH)

- Task ID: `2026-09-11_readme-qq-group`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-11 17:05

## 1. Summary

- **What was done**: Added a "Community"/"社区" section to both `README.md` and `README.zh-CN.md`, listing the shared QQ group (`1056132097`) that covers `billion-context`, `billion-context-pi`, and `opencode-acp`.
- **Why**: Users asked to surface the shared QQ community group across all three project READMEs, in both English and Chinese.
- **Behavior / compatibility changes**: No — documentation only.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `README.md` — added `## Community` section near the top (before the first content section).
- `README.zh-CN.md` — added `## 社区` section near the top (before the first content section).

## 4. Testing & Verification

### Results

- **PASS/FAIL**: PASS (docs-only; no build/test needed)
- Verified diff touches only the two README files (+6 lines each); `package.json` version untouched.

## 5. Risk Assessment & Rollback

- **Risk points**: None functional.
- **Rollback method**: Revert the single commit.
- **Compatibility notes** (data format, config schema): No.
