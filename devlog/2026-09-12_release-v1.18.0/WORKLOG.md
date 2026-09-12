# WORKLOG — v1.18.0 发布(纯版本簿记)

## 步骤

1. 初版发布分支(cc868b3)曾捆绑评审修复 —— 按用户要求"发布 PR 不得含
   功能代码"拆分:
   - 修复 → PR #393(分支 `2026-09-12_candidates-review-fixes`,210a152)
   - 本分支 `git reset --hard github/master`(d0c3875)后仅保留簿记
2. `package.json` 1.17.1 → 1.18.0。
3. CHANGELOG.md / CHANGELOG.zh-CN.md 增加 v1.18.0 条目(内容描述以
   #393 先合并为前提)。
4. 验证:`check-pr.sh` 全绿(分支名 / devlog / changelog 版本串)。

## 验证结果

- 发布 PR #392 已更新为纯簿记 diff(3 文件 + devlog);合并顺序:
   **先 #393(修复)后 #392(发布)**。#393 合并后本分支需 Update branch
   同步 master,再等 CI 绿。
