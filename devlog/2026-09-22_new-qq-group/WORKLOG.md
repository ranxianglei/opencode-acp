# WORKLOG - Update QQ community group in README (EN + ZH)

- Task ID: `2026-09-22_new-qq-group`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-22 13:05

## 1. Summary

- **What was done**: Updated the "Community"/"社区" section in both `README.md` and `README.zh-CN.md` to point at the new shared QQ group (`1108730198`), marking the original group (`1056132097`) as full.
- **Why**: The original group reached its member cap; a new group was created. Users asked for the same update to be applied across all three sibling project READMEs.
- **Behavior / compatibility changes**: No — documentation only.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `README.md` — updated `## Community` section: new group `1108730198` primary, original `1056132097` noted as full.
- `README.zh-CN.md` — updated `## 社区` section: new group `1108730198` primary, original `1056132097` noted as full.

## 4. Testing & Verification

### Results

- **PASS/FAIL**: PASS (docs-only; no build/test needed)
- Verified diff touches only the two README files (+2/-2 lines each); `package.json` version untouched.

## 5. Risk Assessment & Rollback

- **Risk points**: None functional.
- **Rollback method**: Revert the single commit.
- **Compatibility notes** (data format, config schema): No.
